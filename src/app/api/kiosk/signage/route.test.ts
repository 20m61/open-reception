/**
 * GET /api/kiosk/signage のテスト (#101 / #362 実ブラウザ検証で発見した回帰)。
 *
 * クエリ未指定のフォールバックは lib/tenant/default-scope の既定スコープ
 * （internal / default-site）に一致させる。以前は 'default' がハードコードされており、
 * seed サイト 'default-site' と食い違って KioskFlow の待機サイネージが常に空になっていた
 * （default-scope.ts が #171 で潰したのと同型の食い違い）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getKioskSignage = vi.fn();

vi.mock('@/lib/signage/kiosk-signage', () => ({
  getKioskSignage: (...a: unknown[]) => getKioskSignage(...a),
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  getKioskSignage.mockResolvedValue({ enabled: true, defaultIntervalSeconds: 10, items: [] });
});

describe('GET /api/kiosk/signage', () => {
  it('クエリ未指定は既定スコープ internal / default-site で取得する', async () => {
    const res = await GET(new Request('http://localhost/api/kiosk/signage'));
    expect(res.status).toBe(200);
    expect(getKioskSignage).toHaveBeenCalledWith('internal', 'default-site');
  });

  it('クエリ指定時はその tenantId / siteId で取得する', async () => {
    const res = await GET(
      new Request('http://localhost/api/kiosk/signage?tenantId=acme&siteId=hq'),
    );
    expect(res.status).toBe(200);
    expect(getKioskSignage).toHaveBeenCalledWith('acme', 'hq');
  });
});
