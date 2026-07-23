/**
 * 担当者応答ルートの単体テスト。
 * 認可（応答トークン・受付一致）・状態（calling 必須）・secret 非漏えい・正常系を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const markConnected = vi.fn();
const resolveVonageSessionService = vi.fn();
const getVonagePublicConfigForTenant = vi.fn();
const readAnswerToken = vi.fn();

vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
  markConnected: (...a: unknown[]) => markConnected(...a),
}));
vi.mock('@/lib/call/adapter-factory', () => ({
  resolveVonageSessionService: (...a: unknown[]) => resolveVonageSessionService(...a),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  getVonagePublicConfigForTenant: (...a: unknown[]) => getVonagePublicConfigForTenant(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('@/lib/call/answer-token', () => ({ readAnswerToken: (...a: unknown[]) => readAnswerToken(...a) }));

import { POST } from './route';

function call(id = 'rec-1', token: string | undefined = 'tok') {
  return POST(
    new Request('http://localhost/api/staff/calls/rec-1/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readAnswerToken.mockResolvedValue({ receptionId: 'rec-1' });
  getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'calling' } });
  resolveVonageSessionService.mockReturnValue({
    issueToken: vi.fn().mockResolvedValue({ token: 'sub-token', role: 'subscriber', expiresAt: '2026-01-01T00:00:00.000Z' }),
  });
  getVonagePublicConfigForTenant.mockReturnValue({ applicationId: 'app-123' });
  markConnected.mockResolvedValue({ ok: true, value: { id: 'rec-1', state: 'connected', callOutcome: 'connected' } });
});

describe('POST /api/staff/calls/:id/answer', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await call()).status).toBe(403);
    expect(getReception).not.toHaveBeenCalled();
  });

  it('403 when the token is for a different reception', async () => {
    readAnswerToken.mockResolvedValue({ receptionId: 'other' });
    expect((await call('rec-1')).status).toBe(403);
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    expect((await call()).status).toBe(404);
  });

  it('409 when vonage call session is unavailable', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: undefined } });
    expect((await call()).status).toBe(409);
  });

  it('409 when the reception is not in a callable state', async () => {
    // calling でなく connected でもない（例: timeout/cancelled）→ 不正遷移として 409。
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'timeout' } });
    markConnected.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'no' } });
    expect((await call()).status).toBe(409);
  });

  it('is idempotent: already-connected reception re-issues a token (rejoin)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'k', vonageSessionId: 'sess-9', state: 'connected' } });
    markConnected.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'already' } });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe('sub-token');
  });

  it('502 without changing state when token issuance fails', async () => {
    resolveVonageSessionService.mockReturnValue({
      issueToken: vi.fn().mockRejectedValue(new Error('jwt error')),
    });
    const res = await call();
    expect(res.status).toBe(502);
    expect(markConnected).not.toHaveBeenCalled(); // 状態を変えない
  });

  it('issues a subscriber token and marks connected — never a secret', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(markConnected).toHaveBeenCalledWith('rec-1', 'staff');
    const data = await res.json();
    expect(data).toEqual({
      applicationId: 'app-123',
      sessionId: 'sess-9',
      token: 'sub-token',
      role: 'subscriber',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(Object.keys(data).join(',').toLowerCase()).not.toMatch(/secret|private|apikey|api_key/);
    // テナント解決へ配線されていること（既定スコープの tenantId で解決）。
    expect(resolveVonageSessionService).toHaveBeenCalledWith('internal');
    expect(getVonagePublicConfigForTenant).toHaveBeenCalledWith('internal');
  });
});
