import { beforeEach, describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId } from '@/domain/visit/types';
import { CHECKOUT_MAX_ATTEMPTS } from '@/components/kiosk/checkout/self-id';
import {
  CheckoutCredentialService,
  type CheckoutIssueInput,
} from './checkout-credential';

/**
 * 退館クレデンシャルサービス (issue #328)。
 *
 * 発行（高エントロピー token + 一意な 4 桁コード）、解決（QR token / code+ラベル照合）、
 * 確定（consume）を、サイト境界・TTL・試行上限・二重確定の各境界で検証する。
 * PII は保存/返却しない（非 PII サマリのみ）。
 */

const T1 = asTenantId('tenant-1');
const S1 = asSiteId('site-1');
const S2 = asSiteId('site-2');

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

describe('CheckoutCredentialService.issue (#328)', () => {
  it('token（高エントロピー）と 4 桁コードと expiresAt を発行する', () => {
    const svc = new CheckoutCredentialService({ now: () => NOW });
    const cred = svc.issue(baseInput());
    expect(cred.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(cred.code).toMatch(/^[0-9]{4}$/);
    expect(Date.parse(cred.expiresAt)).toBeGreaterThan(NOW.getTime());
  });

  it('同一サイトのアクティブなコードは衝突しない（再ロールする）', () => {
    // 最初の 2 回は同じコード、その後は別コードを返す stub。
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

describe('CheckoutCredentialService QR/token 経路 (#328)', () => {
  let svc: CheckoutCredentialService;
  let token: string;
  beforeEach(() => {
    svc = new CheckoutCredentialService({ now: () => NOW });
    token = svc.issue(baseInput()).token;
  });

  it('正しい token を同一サイトで解決し非 PII サマリを返す', () => {
    const r = svc.resolve({ tenantId: T1, siteId: S1 }, { kind: 'token', payload: token });
    expect(r).toEqual({
      ok: true,
      method: 'qr',
      summary: { checkedInAt: '2026-07-12T08:30:00.000Z', targetLabel: '総務部', purpose: '打ち合わせ' },
    });
  });

  it('QR URL 形式でも解決できる', () => {
    const r = svc.resolve(
      { tenantId: T1, siteId: S1 },
      { kind: 'token', payload: `https://x.example/kiosk/checkout?ct=${token}` },
    );
    expect(r.ok).toBe(true);
  });

  it('別サイトからは解決できない（cross-site isolation）', () => {
    const r = svc.resolve({ tenantId: T1, siteId: S2 }, { kind: 'token', payload: token });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('未知 token は not_found、壊れた payload は invalid', () => {
    expect(svc.resolve({ tenantId: T1, siteId: S1 }, { kind: 'token', payload: 'zzzznope' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(svc.resolve({ tenantId: T1, siteId: S1 }, { kind: 'token', payload: 'a b/c' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('TTL 超過で expired', () => {
    const later = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    const r = svc.resolve({ tenantId: T1, siteId: S1 }, { kind: 'token', payload: token }, later);
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('CheckoutCredentialService コード経路（ラベル照合・試行上限） (#328)', () => {
  let svc: CheckoutCredentialService;
  let code: string;
  const scope = { tenantId: T1, siteId: S1 };
  beforeEach(() => {
    let n = 0;
    svc = new CheckoutCredentialService({ now: () => NOW, randomCode: () => ['4242'][n++] ?? '4242' });
    code = svc.issue(baseInput()).code;
    expect(code).toBe('4242');
  });

  it('コード + 正しいラベルで解決する', () => {
    const r = svc.resolve(scope, { kind: 'code', code: '4242', targetLabel: ' 総務部 ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('code');
  });

  it('不正な形式のコードは invalid', () => {
    expect(svc.resolve(scope, { kind: 'code', code: '42', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('存在しないコードは not_found', () => {
    expect(svc.resolve(scope, { kind: 'code', code: '0000', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('ラベル不一致は label_mismatch を返し、試行を消費し、上限で locked になる', () => {
    for (let i = 0; i < CHECKOUT_MAX_ATTEMPTS - 1; i++) {
      expect(svc.resolve(scope, { kind: 'code', code: '4242', targetLabel: '営業部' })).toEqual({
        ok: false,
        reason: 'label_mismatch',
      });
    }
    // 上限到達で locked。
    expect(svc.resolve(scope, { kind: 'code', code: '4242', targetLabel: '営業部' })).toEqual({
      ok: false,
      reason: 'locked',
    });
    // 以降は正しいラベルでも locked（再発行が必要）。
    expect(svc.resolve(scope, { kind: 'code', code: '4242', targetLabel: '総務部' })).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  it('別サイトの同一コードは解決しない（cross-site isolation）', () => {
    expect(
      svc.resolve({ tenantId: T1, siteId: S2 }, { kind: 'code', code: '4242', targetLabel: '総務部' }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('CheckoutCredentialService.consume 確定と二重確定 (#328)', () => {
  const scope = { tenantId: T1, siteId: S1 };
  it('token 確定で stayId を返し、二重確定は already_checked_out', () => {
    const svc = new CheckoutCredentialService({ now: () => NOW });
    const token = svc.issue(baseInput({ stayId: asStayId('stay-xyz') })).token;

    const first = svc.consume(scope, { kind: 'token', payload: token });
    expect(first).toEqual({ ok: true, method: 'qr', stayId: asStayId('stay-xyz') });

    const second = svc.consume(scope, { kind: 'token', payload: token });
    expect(second).toEqual({ ok: false, reason: 'already_checked_out' });

    // consumed 後は resolve も already_checked_out。
    expect(svc.resolve(scope, { kind: 'token', payload: token })).toEqual({
      ok: false,
      reason: 'already_checked_out',
    });
  });

  it('consume はラベル不一致では確定しない', () => {
    let n = 0;
    const svc = new CheckoutCredentialService({ now: () => NOW, randomCode: () => ['7777'][n++] ?? '7777' });
    svc.issue(baseInput());
    expect(svc.consume(scope, { kind: 'code', code: '7777', targetLabel: '営業部' })).toEqual({
      ok: false,
      reason: 'label_mismatch',
    });
  });
});
