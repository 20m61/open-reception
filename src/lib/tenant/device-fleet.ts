/**
 * 端末死活の横断集計（fleet summary）供給層 (issue #261)。
 *
 * admin ダッシュボード（/api/admin/dashboard, #86）と platform オブザーバビリティ
 * （/api/platform/observability, #83/#90）の **両 surface がこの 1 関数を共有**する。
 * 集計ロジック（union・分母是正）は純関数 summarizeFleet（domain/tenant/device-liveness）に
 * 委譲し、ここはデータ取得と境界化（キャッシュ）だけを担う。surface ごとに別ロジックで
 * online 数が食い違う問題（#260 撤回理由 2）を構造的に防ぐ。
 *
 * 境界化（#261 AC3、#260 撤回理由 3）: Device / kiosk の全件走査は **TTL キャッシュ越しのみ**
 * 行う。リクエスト毎のフルスキャンはせず、走査は TTL（30 秒）に 1 回へ抑える（amortized O(1)）。
 * 死活のオンライン窓は 5 分なので 30 秒の staleness は表示品質に影響しない。
 * Lambda 等の複数インスタンスではインスタンス毎のキャッシュになるが、読み取り専用の
 * 件数集計であり一貫性要件はない。台数が大きく増えた場合の恒久解（lastSeenAt GSI /
 * 維持カウンタによる境界クエリ）は次増分（issue #261 参照）。
 *
 * 認可: 本関数は認可を行わない。呼び出し route 側が担う（observability は
 * authorizePlatform=developer 限定、dashboard は admin セッション境界）。返すのは件数のみで
 * PII・token を含まない。
 */
import { summarizeFleet, type FleetSummary } from '@/domain/tenant/device-liveness';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { getTenantStore } from '@/lib/tenant/store';

export type { FleetSummary } from '@/domain/tenant/device-liveness';

/** 走査を抑える TTL。オンライン窓（5 分）より十分小さく、表示鮮度と負荷のバランスを取る。 */
export const DEVICE_FLEET_CACHE_TTL_MS = 30_000;

let cache: { at: number; value: FleetSummary } | undefined;

/**
 * Device / kiosk 両レジストリの union で端末死活を集計して返す。
 * 取得失敗は握り潰さず伝播する（監視 surface に偽の健全表示を出さない）。
 */
export async function summarizeDeviceFleet(now: Date = new Date()): Promise<FleetSummary> {
  const at = now.getTime();
  // 時計の巻き戻り（at < cache.at）はキャッシュ鮮度を判定できないため信用しない。
  if (cache && at >= cache.at && at - cache.at < DEVICE_FLEET_CACHE_TTL_MS) {
    return cache.value;
  }
  const [devices, kiosks] = await Promise.all([
    getTenantStore().devices.listAllDevices(),
    listKiosks(),
  ]);
  const value = summarizeFleet(
    devices,
    kiosks.map((k) => ({ id: k.id, enabled: k.enabled })),
    now,
  );
  cache = { at, value };
  return value;
}

/** テスト用: キャッシュを破棄する（テスト間の集計持ち越しを防ぐ）。 */
export function __resetDeviceFleetCache(): void {
  cache = undefined;
}
