/**
 * status ルート（受付端末向け状態ポーリング）の単体テスト。
 * 認可（kiosk セッション必須・端末一致 = issue #342 の受付所有権チェック）を検証する。
 * issue #348: 受付作成時の kioskId が認証済みセッション由来で確定するようになったため、
 * 同一端末からの status 取得は 403 にならないこと、別端末からは引き続き 403 になることを
 * 固定する（回帰防止）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const getReceptionVisitorStatus = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
  getReceptionVisitorStatus: (...a: unknown[]) => getReceptionVisitorStatus(...a),
}));

import { GET } from './route';

function call(id = 'rec-1') {
  return GET(new Request('http://localhost/api/kiosk/receptions/rec-1/status'), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/receptions/:id/status', () => {
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

  it('403 when the reception belongs to a different kiosk (#342 defense preserved)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'other-kiosk' } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(getReceptionVisitorStatus).not.toHaveBeenCalled();
  });

  it('200 when the same kiosk session created the reception (#348 fix: no longer 403)', async () => {
    getReception.mockResolvedValue({ ok: true, value: { id: 'rec-1', kioskId: 'kiosk-1' } });
    getReceptionVisitorStatus.mockResolvedValue({ ok: true, value: { state: 'calling' } });
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ state: 'calling' });
  });
});
