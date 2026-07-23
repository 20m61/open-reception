/**
 * token ルート（受付端末 publisher トークン配布）の単体テスト。
 * 認可（kiosk セッション必須・端末一致）とセキュリティ（secret 非漏えい）・レスポンス形を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const resolveVonageSessionService = vi.fn();
const getVonagePublicConfigForTenant = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({ getReception: (...a: unknown[]) => getReception(...a) }));
vi.mock('@/lib/call/adapter-factory', () => ({
  resolveVonageSessionService: (...a: unknown[]) => resolveVonageSessionService(...a),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  getVonagePublicConfigForTenant: (...a: unknown[]) => getVonagePublicConfigForTenant(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));

import { GET } from './route';

function call(id = 'rec-1') {
  return GET(new Request('http://localhost/api/kiosk/receptions/rec-1/token'), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/receptions/:id/token', () => {
  it('403 when there is no valid kiosk session', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('403 when the reception belongs to a different kiosk', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'other-kiosk', vonageSessionId: 's' } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(resolveVonageSessionService).not.toHaveBeenCalled();
  });

  it('409 when vonage is unavailable or no session is established', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1', vonageSessionId: undefined } });
    resolveVonageSessionService.mockReturnValue(null);
    getVonagePublicConfigForTenant.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(409);
  });

  it('409 when vonage is configured but the call session is not yet established', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1', vonageSessionId: undefined } });
    resolveVonageSessionService.mockReturnValue({ issueToken: vi.fn() });
    getVonagePublicConfigForTenant.mockReturnValue({ applicationId: 'app-123' });
    const res = await call();
    expect(res.status).toBe(409);
  });

  it('returns applicationId/sessionId/token only — never a secret', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1', vonageSessionId: 'sess-9' } });
    resolveVonageSessionService.mockReturnValue({
      issueToken: vi.fn().mockResolvedValue({ token: 'jwt-token', role: 'publisher', expiresAt: '2026-01-01T00:00:00.000Z' }),
    });
    getVonagePublicConfigForTenant.mockReturnValue({ applicationId: 'app-123' });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      applicationId: 'app-123',
      sessionId: 'sess-9',
      token: 'jwt-token',
      role: 'publisher',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const keys = Object.keys(body).join(',').toLowerCase();
    expect(keys).not.toMatch(/secret|private|apikey|api_key/);
    // テナント解決へ配線されていること（既定スコープの tenantId で解決）。
    expect(resolveVonageSessionService).toHaveBeenCalledWith('internal');
    expect(getVonagePublicConfigForTenant).toHaveBeenCalledWith('internal');
  });
});
