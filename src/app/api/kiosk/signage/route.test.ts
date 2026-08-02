/**
 * GET /api/kiosk/signage のテスト (#101 / #362 / #601)。
 *
 * ## スコープはセッション由来 (#601)
 *
 * かつて `tenantId` / `siteId` を**クエリで受けており、しかも無認証**だった。id を推測・
 * 列挙すれば他テナントの掲示が読める状態で、「対象 tenantId はサーバ側の認可済み
 * コンテキストから導出する」という規約に反していた。
 *
 * 旧テストには「クエリ指定時はその tenantId / siteId で取得する」という項目があり、
 * **脆弱な挙動をそのまま固定していた**。反転させ、クエリで他テナントを指定しても
 * 自分のスコープが返ることを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getKioskSignage = vi.fn();
const requireKioskSession = vi.fn();
const resolveKioskScope = vi.fn();

vi.mock('@/lib/signage/kiosk-signage', () => ({
  getKioskSignage: (...a: unknown[]) => getKioskSignage(...a),
}));
vi.mock('@/lib/kiosk/session-guard', () => ({
  requireKioskSession: () => requireKioskSession(),
}));
vi.mock('@/lib/voice-transport/kiosk-scope', () => ({
  resolveKioskScope: (...a: unknown[]) => resolveKioskScope(...a),
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  getKioskSignage.mockResolvedValue({ enabled: true, defaultIntervalSeconds: 10, items: [] });
  requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  resolveKioskScope.mockResolvedValue({ tenantId: 'internal', siteId: 'default-site' });
});

describe('GET /api/kiosk/signage', () => {
  it('セッションの端末が属するスコープで取得する', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(resolveKioskScope).toHaveBeenCalledWith('kiosk-1');
    expect(getKioskSignage).toHaveBeenCalledWith('internal', 'default-site');
  });

  it('kiosk セッションが無ければ 403', async () => {
    requireKioskSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(getKioskSignage).not.toHaveBeenCalled();
  });

  /**
   * **越境させない。** 端末レジストリ由来のスコープだけを使い、リクエストからは一切
   * スコープを受け取らない（そもそも `GET` は Request を受け取らない形にしてある）。
   */
  it('別の端末のスコープは返らない', async () => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-acme' });
    resolveKioskScope.mockResolvedValue({ tenantId: 'acme', siteId: 'hq' });
    await GET();
    expect(getKioskSignage).toHaveBeenCalledWith('acme', 'hq');
    expect(getKioskSignage).not.toHaveBeenCalledWith('internal', 'default-site');
  });
});
