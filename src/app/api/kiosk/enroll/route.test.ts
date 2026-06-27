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

const readEnrollmentToken = vi.fn();
const consumeEnrollment = vi.fn();
const issueKioskSession = vi.fn();

vi.mock('@/lib/auth/kiosk-enrollment', () => ({
  readEnrollmentToken: (...a: unknown[]) => readEnrollmentToken(...a),
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
