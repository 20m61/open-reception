/**
 * ワンタップ満足度フィードバック API の単体テスト (issue #320)。
 * kiosk セッション必須ガードと、ストア層への委譲・エラー変換を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordSatisfactionFeedback = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  recordSatisfactionFeedback: (...a: unknown[]) => recordSatisfactionFeedback(...a),
}));

import { POST } from './route';

function post(body: unknown = { rating: 'happy' }, id = 'rcp-1') {
  return POST(
    new Request(`http://localhost/api/kiosk/receptions/${id}/feedback`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  recordSatisfactionFeedback.mockResolvedValue({ ok: true });
});

describe('POST /api/kiosk/receptions/:id/feedback', () => {
  it('kiosk セッションが無ければ 403（記録しない）', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(403);
    expect(recordSatisfactionFeedback).not.toHaveBeenCalled();
  });

  it('kiosk セッションがあればストアへ委譲し 200', async () => {
    const res = await post({ rating: 'happy', reasonCodes: ['waitTooLong'] });
    expect(res.status).toBe(200);
    expect(recordSatisfactionFeedback).toHaveBeenCalledWith('rcp-1', 'kiosk-1', {
      rating: 'happy',
      reasonCodes: ['waitTooLong'],
    });
  });

  it('不正な JSON ボディは 400（invalid_input）', async () => {
    const res = await POST(
      new Request('http://localhost/api/kiosk/receptions/rcp-1/feedback', {
        method: 'POST',
        body: 'not-json',
      }),
      { params: Promise.resolve({ id: 'rcp-1' }) },
    );
    expect(res.status).toBe(400);
    expect(recordSatisfactionFeedback).not.toHaveBeenCalled();
  });

  it('ストアが invalid_input を返せば 400', async () => {
    recordSatisfactionFeedback.mockResolvedValue({ ok: false, error: 'invalid_input' });
    const res = await post();
    expect(res.status).toBe(400);
  });

  it('ストアが not_found を返せば 404', async () => {
    recordSatisfactionFeedback.mockResolvedValue({ ok: false, error: 'not_found' });
    const res = await post();
    expect(res.status).toBe(404);
  });

  it('ストアが forbidden を返せば 403（他 kiosk の受付）', async () => {
    recordSatisfactionFeedback.mockResolvedValue({ ok: false, error: 'forbidden' });
    const res = await post();
    expect(res.status).toBe(403);
  });
});
