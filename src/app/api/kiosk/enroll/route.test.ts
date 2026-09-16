/**
 * kiosk enroll ルートの単体テスト (docs/reception-issuance-design.md inc1)。
 *
 * エンロールトークン → kiosk セッション交換の HTTP マッピングを検証する:
 *   - 署名 NG/期限切れ → 400 invalid_token
 *   - consume 失敗（used/not_found/revoked）→ 409/404/403
 *   - 成功 → 200 + httpOnly kiosk_session cookie 設定
 *   - token をレスポンスに残さない
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { __resetSecretUnavailableLog } from '@/lib/auth/secret-unavailable';

const readEnrollmentToken = vi.fn();
const consumeEnrollment = vi.fn();
const issueKioskSession = vi.fn();

const getEnrollmentSecret = vi.fn(() => 'TEST-enrollment-secret');
vi.mock('@/lib/auth/kiosk-enrollment', () => ({
  readEnrollmentToken: (...a: unknown[]) => readEnrollmentToken(...a),
  getEnrollmentSecret: () => getEnrollmentSecret(),
}));
vi.mock('@/lib/tenant/store', () => ({
  getDeviceService: () => ({ consumeEnrollment: (...a: unknown[]) => consumeEnrollment(...a) }),
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  KIOSK_SESSION_TTL_MS: 1000 * 60 * 60 * 24 * 30,
  issueKioskSession: (...a: unknown[]) => issueKioskSession(...a),
}));

import { POST } from './route';

function call(token: unknown = 'tok') {
  return POST(
    new Request('http://localhost/api/kiosk/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  );
}

const claims = { tenantId: 'internal', siteId: 'default-site', deviceId: 'kiosk-dev', jti: 'j1' };

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` は呼び出し履歴だけを消し、**実装は残る**。
  // 鍵を throw させるテストの実装が次のテストへ漏れないよう、毎回立て直す。
  getEnrollmentSecret.mockImplementation(() => 'TEST-enrollment-secret');
  readEnrollmentToken.mockResolvedValue(claims);
  consumeEnrollment.mockResolvedValue({ ok: true, kioskId: 'kiosk-dev' });
  issueKioskSession.mockResolvedValue('signed-kiosk-session');
});

describe('POST /api/kiosk/enroll', () => {
  it('署名NG/期限切れトークンは 400 invalid_token', async () => {
    readEnrollmentToken.mockResolvedValue(null);
    const res = await call('bad');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_token');
    expect(consumeEnrollment).not.toHaveBeenCalled();
  });

  it('used は 409', async () => {
    consumeEnrollment.mockResolvedValue({ ok: false, reason: 'used' });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('used');
  });

  it('not_found は 404 / revoked は 403', async () => {
    consumeEnrollment.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await call()).status).toBe(404);
    consumeEnrollment.mockResolvedValue({ ok: false, reason: 'revoked' });
    expect((await call()).status).toBe(403);
  });

  it('成功で 200・kiosk_session cookie を設定し token を残さない', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(issueKioskSession).toHaveBeenCalledWith('kiosk-dev');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('kiosk_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    const body = await res.json();
    expect(body).toEqual({ ok: true, kioskId: 'kiosk-dev' });
    expect(JSON.stringify(body)).not.toContain('signed-kiosk-session');
  });
});

/**
 * 🔴 **鍵未設定デプロイで uncaught 例外を出さない (#1123)。**
 *
 * `getEnrollmentSecret()` は #1021 で failClosed（`KIOSK_ENROLLMENT_SECRET` は元から）なので、
 * 鍵を入れ忘れたデプロイでは `readEnrollmentToken` が throw する。route が受けていないと
 * Next の既定 500 になり、(a) **未認証の誰からでも**スタックトレースを 1 リクエストにつき
 * 1 本生ませられ、(b) 正常時（400）との差が「この環境は鍵を持っていない」の
 * オラクルになる。
 *
 * 写像先を 503 にするのは `src/app/api/kiosk/voice-transport/token/route.ts` の先例に
 * 揃えるため。🔴 **400 との差は残る＝オラクルは閉じていない。** その判断は #1127。
 */
describe('鍵未設定デプロイ (#1123)', () => {

  it('🔴 POST: 鍵の解決が throw しても uncaught にせず 503 を返す', async () => {
    getEnrollmentSecret.mockImplementation(() => {
      throw new Error('KIOSK_ENROLLMENT_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    expect((await call()).status).toBe(503);
  });

  it('🔴 POST: 本文に env 名・鍵名を出さない（未認証で到達できる）', async () => {
    getEnrollmentSecret.mockImplementation(() => {
      throw new Error('KIOSK_ENROLLMENT_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const body = await (await call()).json();
    expect(JSON.stringify(body)).not.toMatch(/SECRET|dev-insecure/);
  });

  /**
   * 🔴 **catch の射程が鍵の解決だけであることを縛る (#1123)。**
   *
   * 散文は 4 route すべてで「`read*` 全体を包まない」と書いているが、**それを見張る
   * テストがどこにも無かった** —— 4 箇所同時に catch を広げる変異が unit 8778 本を
   * 素通りした（レビュー 7 周目の実測）。
   *
   * 広げると、`readEnrollmentToken` に jti 照合の DynamoDB 呼び出しが入った日に、
   * **DynamoDB 障害が `503 unavailable` ＋「KIOSK_ENROLLMENT_SECRET is not set」** として
   * 出る。運用者は**存在しない鍵の設定漏れ**を疑い、しかもラッチが立つので本物の鍵欠落は
   * 同一インスタンスで二度と記録されない。設置者の画面は「サーバー側の問題で登録できません」で
   * 正しいままなので、**症状からは辿れない**。
   */
  it('🔴 POST: 鍵以外の throw は 503 に化けない（catch の射程）', async () => {
    readEnrollmentToken.mockRejectedValue(new Error('boom'));
    await expect(call()).rejects.toThrow('boom');
  });

  /** 🔴 下界。「常に 503」では満たせないよう、鍵が在る環境の無効トークンを併せて縛る。 */
  it('🔴 POST: 鍵が在る環境の無効トークンは従来どおり 400（503 に倒れない）', async () => {
    readEnrollmentToken.mockResolvedValue(null);
    expect((await call()).status).toBe(400);
  });

  /**
   * 🔴 **応答だけでなく記録も配線されていること (#1123 AC3)。**
   * `secretUnavailableResponse()` は「503 を返す」と「設定不備を 1 度だけ記録する」を
   * 束ねている。**束ねたことを配線側で検査しないと、素の 503 へ差し替える変異が素通りする**
   * （レビュー 1 周目の実測）。
   */
  it('🔴 POST: 設定不備を env 名つきで 1 度だけ記録する', async () => {
    getEnrollmentSecret.mockImplementation(() => {
      throw new Error('KIOSK_ENROLLMENT_SECRET is not set in a deployed environment; refusing the insecure dev fallback secret');
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      __resetSecretUnavailableLog();
      for (let i = 0; i < 3; i += 1) await call();
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain('KIOSK_ENROLLMENT_SECRET');
      expect(logged).not.toMatch(/dev-insecure/);
    } finally {
      spy.mockRestore();
      __resetSecretUnavailableLog();
    }
  });
});
