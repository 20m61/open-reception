/**
 * kiosk 向けメンテナンス enforcement ゲート (#290 item3)。
 *
 * プラットフォームコンソール（#83 §8）で登録された予定メンテナンス（MaintenanceWindow）を、
 * 受付端末で実際に効かせるための解決ヘルパ。判定の純ロジックは
 * `@/domain/platform/maintenance-window` の `resolveActiveMaintenance`、本ファイルは I/O
 * （ストア読取・kiosk→tenant/site 解決）と fail-open 方針だけを担う。
 *
 * scope 解決: kioskId は Device.id と一致するため（device-service.ts）、`findDeviceById(kioskId)`
 * で端末の tenant/site を得る。device スコープは kioskId 自身に一致させる。端末未解決でも
 * platform スコープ（および id 一致の device スコープ）のメンテナンスは効く。
 *
 * fail-open の根拠: メンテナンス判定はストア障害時に受付を止めるべきではない（feature-flag-gate と
 * 同じ可用性優先）。実際に受付を止めるのは、プラットフォーム管理者が明示的に登録した「現在有効な
 * unavailable メンテナンス」がある場合のみ（enforcement 側 = kiosk config が impact で分岐する）。
 */
import { asDeviceId } from '@/domain/tenant/types';
import {
  resolveActiveMaintenance,
  type ActiveMaintenance,
  type KioskMaintenanceScope,
} from '@/domain/platform/maintenance-window';
import { getTenantStore } from '@/lib/tenant/store';
import { listMaintenanceWindows } from './maintenance-window-store';

/**
 * kioskId に現在（now）有効なメンテナンスを解決する。無ければ null。判定不能（ストア障害・端末解決
 * 失敗）時も null（fail-open）。
 */
export async function resolveKioskMaintenance(
  kioskId: string,
  now: Date = new Date(),
): Promise<ActiveMaintenance | null> {
  try {
    const trimmed = kioskId.trim();
    const scope: KioskMaintenanceScope = trimmed ? { deviceId: trimmed } : {};
    if (trimmed) {
      const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
      if (device) {
        scope.tenantId = String(device.tenantId);
        scope.siteId = String(device.siteId);
      }
    }
    const windows = await listMaintenanceWindows();
    return resolveActiveMaintenance(windows, scope, now);
  } catch {
    // fail-open: メンテ判定不能で受付端末を止めない（上記 docstring 参照）。
    return null;
  }
}
