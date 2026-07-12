import { beforeEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId } from '@/domain/visit/types';
import {
  CheckoutCredentialService,
  type CheckoutCredentialServiceDeps,
  type CheckoutIssueInput,
} from './checkout-credential';

/**
 * 退館クレデンシャルサービス (issue #328、#339 セキュリティレビュー反映)。
 *
 * 検証:
 *   - 発行（高エントロピー token + サイト内一意な 4 桁コード）
 *   - QR/token 経路（強い経路・スロットルなし・サイト境界二重照合）
 *   - code 経路の**列挙防止**: スロットル（scope 単位スライディングウィンドウ）と
 *     **オラクル封じ**（コード未一致 == ラベル不一致 == 同一 not_recognized）
 *   - **consume ロールバック**: resolveForCheckout は状態を変えず、checkout 成功後の
 *     markConsumed でのみ無効化する（失敗時に来訪者を締め出さない）
 * PII は保存/返却しない（非 PII サマリのみ）。
 */

const T1 = asTenantId('tenant-1');
const S1 = asSiteId('site-1');
const S2 = asSiteId('site-2');
const SCOPE1 = { tenantId: T1, siteId: S1 };
const SCOPE2 = { tenantId: T1, siteId: S2 };

const NOW = new Date('2026-07-12T09:00:00.000Z');

function baseInput(over: Partial<CheckoutIssueInput> = {}): CheckoutIssueInput {
  return {
    tenantId: T1,
    siteId: S1,
    stayId: asStayId('stay-aaa'),
    checkedInAt: '2026-07-12T08:30:00.000Z',
    targetLabel: '総務部',
    purpose: '打ち合わせ',
    ...over,
  };
}

/** 固定コードを発行する service（テスト用）。 */
function withFixedCode(code: string, over: CheckoutCredentialServiceDeps = {}) {
  return new CheckoutCredentialService({ now: () => NOW, randomCode: () => code, ...over });
}

describe('issue (#328)', () => {
  it('token（高エントロピー）と 4 桁コードと expiresAt を発行する', () => {
    const svc = new CheckoutCredentialService({ now: () => NOW });
    const cred = svc.issue(baseInput());
    expect(cred.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(cred.code).toMatch(/^[0-9]{4}$/);
    expect(Date.parse(cred.expiresAt)).toBeGreaterThan(NOW.getTime());
  });

  it('同一サイトのアクティブなコードは衝突しない（再ロールする）', () => {
    const codes = ['0001', '0001', '0002'];
    let i = 0;
    const svc = new CheckoutCredentialService({
      now: () => NOW,
      randomCode: () => codes[Math.min(i++, codes.length - 1)] ?? '0002',
    });
    const a = svc.issue(baseInput({ stayId: asStayId('stay-a') }));
    const b = svc.issue(baseInput({ stayId: asStayId('stay-b') }));
    expect(a.code).toBe('0001');
    expect(b.code).toBe('0002');
  });
});

describe('QR/token 経路 (#328)', () => {
  let svc: CheckoutCredentialService;
  let token: string;
  beforeEach(() => {
    svc = new CheckoutCredentialService({ now: () => NOW });
    token = svc.issue(baseInput()).token;
  });

  it('正しい token を同一サイトで解決し非 PII サマリを返す', () => {
    expect(svc.resolve(SCOPE1, { kind: 'token', payload: token })).toEqual({
      ok: true,
      method: 'qr',
      summary: { checkedInAt: '2026-07-12T08:30:00.000Z', targetLabel: '総務部', purpose: '打ち合わせ' },
    });
  });

  it('QR URL 形式でも解決できる', () => {
    const r = svc.resolve(SCOPE1, { kind: 'token', payload: `https://x.example/kiosk/checkout?ct=${token}` });
    expect(r.ok).toBe(true);
  });

  it('別サイトからは解決できない（cross-site isolation）', () => {
    expect(svc.resolve(SCOPE2, { kind: 'token', payload: token })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('未知 token は not_found、壊れた payload は invalid', () => {
    expect(svc.resolve(SCOPE1, { kind: 'token', payload: 'zzzznope' })).toEqual({ ok: false, reason: 'not_found' });
    expect(svc.resolve(SCOPE1, { kind: 'token', payload: 'a b/c' })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('TTL 超過で expired', () => {
    const later = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    expect(svc.resolve(SCOPE1, { kind: 'token', payload: token }, later)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('code 経路 — 正常系と入力検証 (#328)', () => {
  it('コード + 正しいラベルで解決する（method=code）', () => {
    const svc = withFixedCode('4242');
    svc.issue(baseInput());
    const r = svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: ' 総務部 ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('code');
  });

  it('不正な形式のコードは invalid（スロットルに計上しない）', () => {
    const svc = withFixedCode('4242', { codeThrottleMax: 3 });
    svc.issue(baseInput());
    for (let i = 0; i < 5; i++) {
      expect(svc.resolve(SCOPE1, { kind: 'code', code: '42', targetLabel: '総務部' })).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    // 形式不正は列挙ではないのでスロットルされず、正しいコードは依然解決できる。
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' }).ok).toBe(true);
  });

  it('期限切れの一致コードは expired', () => {
    const svc = withFixedCode('4242');
    svc.issue(baseInput());
    const later = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' }, later)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('code 経路 — 列挙オラクル封じ (#328 / #339)', () => {
  it('未知コードとラベル不一致は同一の失敗（not_recognized）で存在を露呈しない', () => {
    const svc = withFixedCode('4242');
    svc.issue(baseInput());
    const wrongCode = svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: '総務部' });
    const wrongLabel = svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '営業部' });
    expect(wrongCode).toEqual({ ok: false, reason: 'not_recognized' });
    expect(wrongLabel).toEqual({ ok: false, reason: 'not_recognized' });
    // 「生きたコードが存在するか」を区別できない = オラクルが無い。
    expect(wrongCode).toEqual(wrongLabel);
  });
});

describe('code 経路 — スロットル（一次防御） (#328 / #339)', () => {
  it('ウィンドウ内で上限失敗すると、以降は正しいコードでも throttled で塞ぐ', () => {
    const svc = withFixedCode('4242', { codeThrottleMax: 3, codeThrottleWindowMs: 60_000 });
    const issued = svc.issue(baseInput());

    // 3 回の失敗（コード未一致でもラベル不一致でも計上される）。
    for (let i = 0; i < 3; i++) {
      expect(svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: 'x' })).toEqual({
        ok: false,
        reason: 'not_recognized',
      });
    }
    // 上限到達後は**正しい**コード+ラベルでも throttled（盲目的列挙を打ち切る）。
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'throttled',
    });
    // token 経路（256 bit）はスロットルの影響を受けない（同一クレデンシャルの token を使う）。
    expect(svc.resolve(SCOPE1, { kind: 'token', payload: issued.token }).ok).toBe(true);
  });

  it('スロットルは scope 単位（他サイトの試行数に影響されない）', () => {
    const svc = withFixedCode('4242', { codeThrottleMax: 2, codeThrottleWindowMs: 60_000 });
    svc.issue(baseInput({ siteId: S1, stayId: asStayId('s1') }));
    svc.issue(baseInput({ siteId: S2, stayId: asStayId('s2') }));

    // site1 を上限まで失敗させる。
    svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: 'x' });
    svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: 'x' });
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'throttled',
    });

    // site2 は独立して正常に解決できる（cross-site 隔離）。
    expect(svc.resolve(SCOPE2, { kind: 'code', code: '4242', targetLabel: '総務部' }).ok).toBe(true);
  });

  it('ウィンドウ経過で失敗計数がリセットされ、再び解決できる', () => {
    let clock = NOW.getTime();
    const svc = new CheckoutCredentialService({
      now: () => new Date(clock),
      randomCode: () => '4242',
      codeThrottleMax: 2,
      codeThrottleWindowMs: 60_000,
    });
    svc.issue(baseInput());
    svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: 'x' });
    svc.resolve(SCOPE1, { kind: 'code', code: '0000', targetLabel: 'x' });
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'throttled',
    });
    // ウィンドウを越えて時間を進める。
    clock += 61_000;
    expect(svc.resolve(SCOPE1, { kind: 'code', code: '4242', targetLabel: '総務部' }).ok).toBe(true);
  });
});

describe('resolveForCheckout / markConsumed — ロールバック安全性 (#328 / #339)', () => {
  const scope = SCOPE1;

  it('resolveForCheckout は状態を変えない（checkout 失敗でクレデンシャルは再利用可能）', () => {
    const svc = new CheckoutCredentialService({ now: () => NOW });
    const token = svc.issue(baseInput({ stayId: asStayId('stay-xyz') })).token;

    const first = svc.resolveForCheckout(scope, { kind: 'token', payload: token });
    expect(first).toEqual({ ok: true, method: 'qr', stayId: asStayId('stay-xyz'), credentialToken: token });

    // markConsumed を呼ばなければ（= checkout 失敗を模す）まだ有効。
    const again = svc.resolveForCheckout(scope, { kind: 'token', payload: token });
    expect(again.ok).toBe(true);
    expect(svc.resolve(scope, { kind: 'token', payload: token }).ok).toBe(true);
  });

  it('markConsumed 後は token 経路は already_checked_out、code 経路は not_recognized', () => {
    const svc = withFixedCode('7777');
    const issued = svc.issue(baseInput({ stayId: asStayId('stay-c') }));

    const r = svc.resolveForCheckout(scope, { kind: 'token', payload: issued.token });
    expect(r.ok).toBe(true);
    if (r.ok) svc.markConsumed(r.credentialToken);

    // token: 使用済みは区別してよい（token は秘密）。
    expect(svc.resolve(scope, { kind: 'token', payload: issued.token })).toEqual({
      ok: false,
      reason: 'already_checked_out',
    });
    // code: 使用済みは「存在しない」= not_recognized（オラクルを作らない）。
    expect(svc.resolve(scope, { kind: 'code', code: '7777', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'not_recognized',
    });
  });

  it('resolveForCheckout もラベル不一致では確定用に解決しない（not_recognized）', () => {
    const svc = withFixedCode('7777');
    svc.issue(baseInput());
    expect(svc.resolveForCheckout(scope, { kind: 'code', code: '7777', targetLabel: '営業部' })).toEqual({
      ok: false,
      reason: 'not_recognized',
    });
  });
});
