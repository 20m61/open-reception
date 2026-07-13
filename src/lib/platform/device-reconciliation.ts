/**
 * 端末レジストリ整合の read 側（データ修復 dry-run の入力組み立て） (#290 item2)。
 *
 * flat な kiosk レジストリ（#18）と Device レジストリ（#87）を読み、純関数
 * `@/domain/platform/device-reconciliation` へ渡して dry-run プランを算出する。本ファイルは I/O
 * （両レジストリ読取）だけを担い、mutation は一切しない。
 *
 * Device の読みは **テナント一覧起点 + テナント毎の境界クエリ**で行い、無境界の listAllDevices を
 * 使わない（#284 恒久化・device-fleet.ts と同じ方針）。呼び出しは platform 昇格ゲート配下のみ
 * （route 側で assertElevated 済み）で、テナント横断 read は総合開発者に限る。
 */
import {
  reconcileDeviceRegistry,
  type DeviceReconciliationPlan,
} from '@/domain/platform/device-reconciliation';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { getTenantStore } from '@/lib/tenant/store';

/** kiosk / Device 両レジストリを読み、整合の dry-run プランを返す。 */
export async function planDeviceReconciliation(): Promise<DeviceReconciliationPlan> {
  const store = getTenantStore();
  const [kiosks, tenants] = await Promise.all([listKiosks(), store.tenants.listTenants()]);
  const deviceLists = await Promise.all(
    tenants.map((t) => store.devices.listDevicesByTenant(t.id)),
  );
  return reconcileDeviceRegistry(kiosks, deviceLists.flat());
}
