/**
 * token ルート（受付端末 publisher トークン配布）の単体テスト。
 * セキュリティ面（secret 非漏えい・未確立時 409・404）と正常系のレスポンス形を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const getVonageSessionService = vi.fn();
const getVonagePublicConfig = vi.fn();

vi.mock('@/lib/mock-backend/reception-store', () => ({ getReception: (...a: unknown[]) => getReception(...a) }));
vi.mock('@/lib/call/adapter-factory', () => ({
  getVonageSessionService: (...a: unknown[]) => getVonageSessionService(...a),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  getVonagePublicConfig: (...a: unknown[]) => getVonagePublicConfig(...a),
}));

import { GET } from './route';

function call(id = 'rec-1') {
  return GET(new Request('http://localhost/api/kiosk/receptions/rec-1/token'), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/kiosk/receptions/:id/token', () => {
  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('409 when vonage is unavailable or no session is established', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: undefined } });
    getVonageSessionService.mockReturnValue(null);
    getVonagePublicConfig.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(409);
  });

  it('returns applicationId/sessionId/token only — never a secret', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9' } });
    getVonageSessionService.mockReturnValue({
      issueToken: vi.fn().mockResolvedValue({ token: 'jwt-token', role: 'publisher', expiresAt: '2026-01-01T00:00:00.000Z' }),
    });
    getVonagePublicConfig.mockReturnValue({ applicationId: 'app-123' });

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
    // secret/private key 系のキーが応答に含まれないこと。
    const keys = Object.keys(body).join(',').toLowerCase();
    expect(keys).not.toMatch(/secret|private|apikey|api_key/);
  });
});
