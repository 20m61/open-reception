/**
 * 担当者応答アクションルートの単体テスト (issue #99)。
 * 認可（応答トークン・受付一致）・種別バリデーション・状態（calling/connected 必須）・正常系を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordStaffResponse = vi.fn();
const readAnswerToken = vi.fn();

vi.mock('@/lib/mock-backend/reception-store', () => ({
  recordStaffResponse: (...a: unknown[]) => recordStaffResponse(...a),
}));
vi.mock('@/lib/call/answer-token', () => ({ readAnswerToken: (...a: unknown[]) => readAnswerToken(...a) }));

import { POST } from './route';

function call(opts?: { id?: string; token?: string; action?: unknown }) {
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

beforeEach(() => {
  vi.clearAllMocks();
  readAnswerToken.mockResolvedValue({ receptionId: 'rec-1' });
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
    expect((await call()).status).toBe(403);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('403 when the token is for a different reception', async () => {
    readAnswerToken.mockResolvedValue({ receptionId: 'other' });
    expect((await call()).status).toBe(403);
  });

  it('400 when the action is unknown', async () => {
    const res = await call({ action: 'nope' });
    expect(res.status).toBe(400);
    expect(recordStaffResponse).not.toHaveBeenCalled();
  });

  it('404 when the reception does not exist', async () => {
    recordStaffResponse.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    expect((await call()).status).toBe(404);
  });

  it('409 when the reception is not in a callable state', async () => {
    recordStaffResponse.mockResolvedValue({ ok: false, error: { code: 'invalid_transition', message: 'no' } });
    expect((await call()).status).toBe(409);
  });

  it('records the response and returns the visitor-facing result (no PII)', async () => {
    const res = await call({ action: 'coming' });
    expect(res.status).toBe(200);
    expect(recordStaffResponse).toHaveBeenCalledWith('rec-1', 'coming');
    const data = await res.json();
    expect(data.action).toBe('coming');
    expect(data.kioskStatus).toBe('acknowledged');
    // 来訪者の氏名・会社等は返さない（応答結果のみ）。
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
