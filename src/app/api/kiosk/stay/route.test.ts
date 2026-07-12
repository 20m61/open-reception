/**
 * 受付完了時の在館記録自動生成ルートの単体テスト (issue #342)。
 *
 * kiosk セッション必須（サーバ側アクセス制御）、connected 完了のみ在館化、scope が
 * kiosk セッション由来（resolveStayScope）であること、返却が {stayId} のみ（PII なし）を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReception = vi.fn();
const createPresentForReception = vi.fn();
const resolveStayScope = vi.fn();
const readKioskSession = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/data-stores/reception-store', () => ({
  getReception: (...a: unknown[]) => getReception(...a),
}));
vi.mock('@/lib/visit/store', () => ({
  resolveStayScope: (...a: unknown[]) => resolveStayScope(...a),
  getKioskStayService: () => ({ createPresentForReception }),
}));

import { POST } from './route';

function post(body: unknown = { receptionId: 'rec-1' }) {
  return POST(
    new Request('http://localhost/api/kiosk/stay', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

const connectedSession = {
  id: 'rec-1',
  // 受付所有権チェックを通すため、テストセッションと同じ kioskId にする（正常系は 201）。
  kioskId: 'kiosk-session-1',
  state: 'completed',
  callOutcome: 'connected',
  purpose: 'meeting',
  targetLabel: '営業部 佐藤',
  visitor: { name: '山田太郎', company: 'ACME' },
  startedAt: '2026-07-12T09:00:00.000Z',
  updatedAt: '2026-07-12T09:05:00.000Z',
  completedAt: '2026-07-12T09:05:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'kiosk-cookie' });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-session-1' });
  resolveStayScope.mockReturnValue({ tenantId: 'dev-tenant', siteId: 'dev-site' });
  getReception.mockResolvedValue({ ok: true, value: connectedSession });
  createPresentForReception.mockResolvedValue('stay-abc');
});

describe('POST /api/kiosk/stay (issue #342)', () => {
  it('kiosk セッションが無ければ 403（在館記録を作らない）', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(403);
    expect(createPresentForReception).not.toHaveBeenCalled();
  });

  it('receptionId が無ければ 400', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(createPresentForReception).not.toHaveBeenCalled();
  });

  it('connected 完了の受付は在館記録を生成し 201 で {stayId} のみ返す', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ stayId: 'stay-abc' });
    // PII を返さない。
    expect(JSON.stringify(json)).not.toContain('山田');
    expect(createPresentForReception).toHaveBeenCalledTimes(1);
  });

  it('scope は resolveStayScope(session.kioskId) 由来で解決する（越境しない）', async () => {
    await post();
    expect(resolveStayScope).toHaveBeenCalledWith('kiosk-session-1');
    const arg = createPresentForReception.mock.calls[0]![0];
    expect(arg.scope).toEqual({ tenantId: 'dev-tenant', siteId: 'dev-site' });
    expect(arg.stay.tenantId).toBe('dev-tenant');
    expect(arg.stay.siteId).toBe('dev-site');
    expect(arg.stay.receptionId).toBe('rec-1');
    // 監査帰属はセッションの kioskId。
    expect(arg.kioskId).toBe('kiosk-session-1');
    // 作成入力に PII を載せない。
    expect(JSON.stringify(arg.stay)).not.toContain('山田');
  });

  it('別端末が作成した受付は 403 forbidden（在館記録を作らない）', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { ...connectedSession, kioskId: 'kiosk-other' },
    });
    const res = await post();
    expect(res.status).toBe(403);
    expect(createPresentForReception).not.toHaveBeenCalled();
  });

  it('存在しない受付は 404', async () => {
    getReception.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    const res = await post();
    expect(res.status).toBe(404);
    expect(createPresentForReception).not.toHaveBeenCalled();
  });

  it('connected でない完了（フォールバック等）は 409 not_eligible で在館化しない', async () => {
    getReception.mockResolvedValue({
      ok: true,
      value: { ...connectedSession, callOutcome: 'timeout' },
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(createPresentForReception).not.toHaveBeenCalled();
  });

  it('生成中の例外は 503（受付フローを壊さない）', async () => {
    createPresentForReception.mockRejectedValue(new Error('backend down'));
    const res = await post();
    expect(res.status).toBe(503);
  });
});
