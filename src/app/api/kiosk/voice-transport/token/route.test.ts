/**
 * POST /api/kiosk/voice-transport/token の単体テスト (issue #369)。
 * 認可（kiosk セッション必須・受付所有権一致）とレスポンス形（token 以外に secret を含めない）を
 * 検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));
const resolveKioskScope = vi.fn();
const issueVoiceTransportToken = vi.fn();

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({ getReception: (...a: unknown[]) => getReception(...a) }));
vi.mock('@/lib/voice-transport/kiosk-scope', () => ({
  resolveKioskScope: (...a: unknown[]) => resolveKioskScope(...a),
}));
vi.mock('@/lib/voice-transport/token', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice-transport/token')>('@/lib/voice-transport/token');
  return { ...actual, issueVoiceTransportToken: (...a: unknown[]) => issueVoiceTransportToken(...a) };
});

import { POST } from './route';

function call(body: unknown = { receptionSessionId: 'reception-1' }) {
  return POST(
    new Request('http://localhost/api/kiosk/voice-transport/token', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  getReception.mockResolvedValue({ ok: true, value: { id: 'reception-1', kioskId: 'kiosk-1' } });
  resolveKioskScope.mockResolvedValue({ tenantId: 'tenant-1', siteId: 'site-1' });
  issueVoiceTransportToken.mockResolvedValue({ token: 'signed-token', expiresAt: '2026-01-01T00:00:00.000Z' });
});

describe('POST /api/kiosk/voice-transport/token', () => {
  it('403 when there is no valid kiosk session', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('400 when receptionSessionId is missing', async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('400 for a malformed JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/kiosk/voice-transport/token', { method: 'POST', body: '{not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('403 when the reception belongs to a different kiosk (cross-device rejection)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'reception-1', kioskId: 'other-kiosk' } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(issueVoiceTransportToken).not.toHaveBeenCalled();
  });

  it('issues a token bound to the resolved tenant/site and the session kioskId (never client-supplied)', async () => {
    const res = await call({ receptionSessionId: 'reception-1', kioskId: 'attacker-supplied', tenantId: 'attacker-tenant' });
    expect(res.status).toBe(200);
    expect(issueVoiceTransportToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        siteId: 'site-1',
        kioskId: 'kiosk-1',
        receptionSessionId: 'reception-1',
      }),
    );
  });

  it('returns token/expiresAt/audioConfig only — never a secret, and includes a fresh jti per request', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      token: 'signed-token',
      expiresAt: '2026-01-01T00:00:00.000Z',
      audioConfig: { sampleRateHz: 16000, bitDepth: 16, channels: 1, chunkMs: 20, encoding: 'pcm16' },
    });
    const keys = Object.keys(body).join(',').toLowerCase();
    expect(keys).not.toMatch(/secret|private|apikey|api_key/);

    const [claimsArg] = issueVoiceTransportToken.mock.calls[0]!;
    expect(typeof claimsArg.jti).toBe('string');
    expect(claimsArg.jti.length).toBeGreaterThan(10);
  });

  it('issues a distinct jti on each call (no fixed/reused identifier)', async () => {
    await call();
    await call();
    const jti1 = issueVoiceTransportToken.mock.calls[0]![0].jti;
    const jti2 = issueVoiceTransportToken.mock.calls[1]![0].jti;
    expect(jti1).not.toBe(jti2);
  });

  it('503 (fail-closed) when scope resolution fails — store outage is surfaced as unavailable, not 500', async () => {
    resolveKioskScope.mockRejectedValue(new Error('device registry unavailable'));
    const res = await call();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('unavailable');
    // 障害詳細(内部エラー文言)をクライアントへ漏らさない
    expect(body.message).not.toContain('registry');
    expect(issueVoiceTransportToken).not.toHaveBeenCalled();
  });

  it('503 (fail-closed) when token signing is unavailable (e.g. secret missing in deployed env)', async () => {
    issueVoiceTransportToken.mockRejectedValue(new Error('VOICE_TRANSPORT_TOKEN_SECRET is not configured'));
    const res = await call();
    expect(res.status).toBe(503);
  });
});
