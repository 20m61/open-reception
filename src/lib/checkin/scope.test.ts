/**
 * 受付端末の checkin scope は端末台帳から解決し、解けなければ拒否する (#736 Gate A)。
 *
 * ## 事実（修正前）
 *
 * `resolveCheckinScope(_kioskId)` は**引数を捨てて** `dev-tenant` / `dev-site` を返していた。
 * 発行側（`/api/admin/reservations`）は認可済みの実テナントで予約を書くので、
 * **境界が一致せず、発行した QR は必ず「不明な QR」になる**。
 *
 * さらに、仮に既定テナントへ倒す実装のままだと、**未登録の端末が既定テナントの予約を
 * 引ける**。scope は「その端末がどの予約を見られるか」を決めるので、ここは境界そのもの。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findDeviceById = vi.fn();
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById } }),
}));

import { resolveCheckinScope } from './store';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCheckinScope (#736)', () => {
  it('🔴 端末台帳のテナント／サイトを返す（引数を捨てない）', async () => {
    findDeviceById.mockResolvedValue({ tenantId: 'tenant-a', siteId: 'site-1' });
    expect(await resolveCheckinScope('kiosk-1')).toEqual({ tenantId: 'tenant-a', siteId: 'site-1' });
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-1');
  });

  /**
   * 🔴 **既定テナントへ倒さない。** 倒すと未登録端末が他テナントの予約を引ける。
   * 営業状態の解決（`kiosk-gate.ts`）が既定へ fail-open するのは境界を決めていないから。
   */
  it('🔴 未登録の端末では解決しない', async () => {
    findDeviceById.mockResolvedValue(undefined);
    expect(await resolveCheckinScope('kiosk-unknown')).toBeUndefined();
  });

  it('🔴 端末 ID が空でも解決しない', async () => {
    expect(await resolveCheckinScope('   ')).toBeUndefined();
    expect(findDeviceById).not.toHaveBeenCalled();
  });

  it('🔴 台帳が落ちても既定テナントへ倒さない', async () => {
    findDeviceById.mockRejectedValue(new Error('TEST-store-down'));
    expect(await resolveCheckinScope('kiosk-1')).toBeUndefined();
  });
});
