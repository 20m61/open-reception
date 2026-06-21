/**
 * 担当者応答アクションルートの単体テスト (issue #99 inc1/2)。
 * 認可（応答トークン・受付一致）・種別バリデーション・状態（calling/connected 必須）・
 * サイト設定の尊重（無効種別 409・文言上書きの伝播）・有効種別取得 GET を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordStaffResponse = vi.fn();
const getReception = vi.fn();
const readAnswerToken = vi.fn();
const resolveOverrides = vi.fn();
const resolveCheckinScope = vi.fn();

vi.mock('@/lib/mock-backend/reception-store', () => ({
  recordStaffResponse: (...a: unknown[]) => recordStaffResponse(...a),
  getReception: (...a: unknown[]) => getReception(...a),
}));
vi.mock('@/lib/call/answer-token', () => ({ readAnswerToken: (...a: unknown[]) => readAnswerToken(...a) }));
vi.mock('@/lib/checkin/store', () => ({
  resolveCheckinScope: (...a: unknown[]) => resolveCheckinScope(...a),
}));
vi.mock('@/lib/reception/staff-response-config/store', () => ({
  getStaffResponseConfigService: () => ({ resolveOverrides: (...a: unknown[]) => resolveOverrides(...a) }),
}));

import { GET, POST } from './route';

function post(opts?: { id?: string; token?: string; action?: unknown }) {
  const id = opts?.id ?? 'rec-1';
  return POST(
    new Request('http://localhost/api/staff/calls/rec-1/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: opts?.token ?? 'tok', action: opts?.action ?? 'coming' }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(opts?: { id?: string; token?: string }) {
  const id = opts?.id ?? 'rec-1';
  const token = opts?.token ?? 'tok';
  return GET(new Request(`http://localhost/api/staff/calls/rec-1/respond?token=${token}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readAnswerToken.mockResolvedValue({ receptionId: 'rec-1' });
  getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1' } });
  resolveCheckinScope.mockReturnValue({ tenantId: 'dev-tenant', siteId: 'dev-site' });
  resolveOverrides.mockResolvedValue({});
  recordStaffResponse.mockResolvedValue({
    ok: true,
    value: {
      action: 'coming',
      kioskStatus: 'acknowledged',
      visitorMessage: '担当者がまもなくお越しになります。少々お待ちください。',
      severity: 'success',
      offersFallback: false,
      respondedAt: '2026-06-20T00:00:00.000Z',
    },
  });
});

describe('POST /api/staff/calls/:id/respond', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await post()).status).toBe(403);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('403 when the token is for a different reception', async () => {
    readAnswerToken.mockResolvedValue({ receptionId: 'other' });
    expect((await post()).status).toBe(403);
  });

  it('400 when the action is unknown', async () => {
    const res = await post({ action: 'nope' });
    expect(res.status).toBe(400);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('404 when the reception does not exist', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    expect((await post()).status).toBe(404);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('409 when the reception is not in a callable state', async () => {
    recordStaffResponse.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'no' } });
    expect((await post()).status).toBe(409);
  });

  it('409 when the action is disabled for the site', async () => {
    resolveOverrides.mockResolvedValue({ coming: { enabled: false } });
    const res = await post({ action: 'coming' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('action_disabled');
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('passes the configured visitor message override to recordStaffResponse', async () => {
    resolveOverrides.mockResolvedValue({ coming: { messageOverride: 'すぐ参ります' } });
    await post({ action: 'coming' });
    expect(recordStaffResponse).toHaveBeenCalledWith('rec-1', 'coming', {
      messageOverride: 'すぐ参ります',
    });
  });

  it('falls back to the default message when no override is configured', async () => {
    await post({ action: 'coming' });
    expect(recordStaffResponse).toHaveBeenCalledWith('rec-1', 'coming', {
      messageOverride: '担当者がまもなくお越しになります。少々お待ちください。',
    });
  });

  it('records the response and returns the visitor-facing result (no PII)', async () => {
    const res = await post({ action: 'coming' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.action).toBe('coming');
    expect(data.kioskStatus).toBe('acknowledged');
    expect(Object.keys(data).sort()).toEqual([
      'action',
      'kioskStatus',
      'offersFallback',
      'respondedAt',
      'severity',
      'visitorMessage',
    ]);
  });
});

describe('GET /api/staff/calls/:id/respond', () => {
  it('403 when the answer token is invalid', async () => {
    readAnswerToken.mockResolvedValue(null);
    expect((await get()).status).toBe(403);
  });

  it('returns the enabled flags from site config (no visitor message / PII)', async () => {
    resolveOverrides.mockResolvedValue({ decline: { enabled: false } });
    const res = await get();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { actions: Array<Record<string, unknown>> };
    const decline = data.actions.find((a) => a.action === 'decline');
    expect(decline?.enabled).toBe(false);
    const coming = data.actions.find((a) => a.action === 'coming');
    expect(coming?.enabled).toBe(true);
    // 来訪者文言を含まない（種別メタのみ）。
    expect(Object.keys(coming ?? {}).sort()).toEqual([
      'action',
      'enabled',
      'requiresConfirmation',
      'severity',
      'staffLabel',
    ]);
  });
});
