/**
 * 受付セッション作成ルートの単体テスト。kiosk セッション必須ガード (issue #239) と
 * 正常時の作成委譲を検証する。実アクセス制御がクライアントではなくサーバ側にあることを担保する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createReception = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  createReception: (...a: unknown[]) => createReception(...a),
}));

import { POST } from './route';

function post(body: unknown = { purpose: 'meeting' }) {
  return POST(
    new Request('http://localhost/api/kiosk/receptions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  createReception.mockResolvedValue({ ok: true, value: { id: 'rec-1' } });
});

describe('POST /api/kiosk/receptions', () => {
  it('kiosk セッションが無ければ 403（受付を作成しない, #239）', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(403);
    expect(createReception).not.toHaveBeenCalled();
  });

  it('kiosk セッションがあれば作成へ委譲し 201', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(createReception).toHaveBeenCalledTimes(1);
  });

  it('kioskId は認証済みセッション由来で確定し、クライアント送信値は無視する (#348)', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
    await post({ purpose: 'meeting', kioskId: 'kiosk-dev' });
    const input = createReception.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.kioskId).toBe('kiosk-1');
  });

  it('クライアントが kioskId を送らなくてもセッション由来で補完する (#348)', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-2' });
    await post({ purpose: 'meeting' });
    const input = createReception.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.kioskId).toBe('kiosk-2');
  });
});
