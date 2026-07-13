/**
 * 端末レジストリ整合（データ修復の dry-run プラン算出） (#290 item2)。
 *
 * flat な kiosk レジストリ（#18・テナントレス）と、tenant/site 境界を持つ Device レジストリ
 * （#87・source-of-truth）の drift を検出する純関数。I/O は持たない（読取・監査は
 * src/lib/platform/device-reconciliation、enforcement 側の実修復は adoptKiosk/syncKioskState）。
 *
 * この関数は **dry-run 専用**でありプランを返すだけ。実際の作成/更新は行わない。プランは
 * 「実行したら何が起きるか」を昇格した総合開発者へ提示するために使う（#290 の昇格必須 + 高重要度
 * 監査 + dry-run 前提）。
 */
import type { Device, DeviceStatus } from '@/domain/tenant/types';
import type { Kiosk } from '@/domain/kiosk/types';

/** 修復アクション種別。 */
export type ReconcileAction = 'adopt' | 'sync_status' | 'device_only';

/** 整合プランの 1 項目（PII を含めない。id・status・enabled のみ）。 */
export type DeviceReconciliationItem = {
  id: string;
  action: ReconcileAction;
  /** kiosk 側の有効状態（adopt / sync_status）。 */
  kioskEnabled?: boolean;
  /** 現在の Device.status（sync_status / device_only）。 */
  deviceStatus?: DeviceStatus;
  /** 適用後に期待される Device.status（adopt / sync_status）。 */
  targetStatus?: DeviceStatus;
};

/** 端末レジストリ整合の dry-run プラン。 */
export type DeviceReconciliationPlan = {
  /** kiosk-store にあり Device が無い（adoptKiosk 相当で新規作成される）。 */
  adopt: DeviceReconciliationItem[];
  /** id 一致だが status 不一致（syncKioskState 相当で status 更新される）。 */
  syncStatus: DeviceReconciliationItem[];
  /** Device のみ（kiosk-store に無い）。情報提供のみ（自動修復対象外）。 */
  deviceOnly: DeviceReconciliationItem[];
  /** 修復対象の差分件数（adopt + syncStatus。deviceOnly は情報のみで含めない）。 */
  driftCount: number;
  /** 走査した kiosk / device の総数。 */
  kioskCount: number;
  deviceCount: number;
};

/** kiosk.enabled → Device.status（syncKioskState / adoptKiosk と同じ写像）。 */
function statusFromEnabled(enabled: boolean): DeviceStatus {
  return enabled ? 'active' : 'revoked';
}

/**
 * kiosk レジストリと Device レジストリの drift を算出する純関数（dry-run）。id 一致で突き合わせる
 * （adoptKiosk / syncKioskState の統合方針と同じ id 一致）。
 */
export function reconcileDeviceRegistry(
  kiosks: readonly Kiosk[],
  devices: readonly Device[],
): DeviceReconciliationPlan {
  const deviceById = new Map(devices.map((d) => [String(d.id), d]));
  const kioskIds = new Set(kiosks.map((k) => k.id));

  const adopt: DeviceReconciliationItem[] = [];
  const syncStatus: DeviceReconciliationItem[] = [];

  for (const kiosk of kiosks) {
    const target = statusFromEnabled(kiosk.enabled);
    const device = deviceById.get(kiosk.id);
    if (!device) {
      adopt.push({ id: kiosk.id, action: 'adopt', kioskEnabled: kiosk.enabled, targetStatus: target });
    } else if (device.status !== target) {
      syncStatus.push({
        id: kiosk.id,
        action: 'sync_status',
        kioskEnabled: kiosk.enabled,
        deviceStatus: device.status,
        targetStatus: target,
      });
    }
  }

  const deviceOnly: DeviceReconciliationItem[] = devices
    .filter((d) => !kioskIds.has(String(d.id)))
    .map((d) => ({ id: String(d.id), action: 'device_only', deviceStatus: d.status }));

  return {
    adopt,
    syncStatus,
    deviceOnly,
    driftCount: adopt.length + syncStatus.length,
    kioskCount: kiosks.length,
    deviceCount: devices.length,
  };
}
