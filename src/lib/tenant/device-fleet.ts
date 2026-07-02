/**
 * 端末死活の横断集計（fleet summary）供給層 (issue #261)。
 *
 * admin ダッシュボード（/api/admin/dashboard, #86）と platform オブザーバビリティ
 * （/api/platform/observability, #83/#90）の **両 surface がこの 1 関数を共有**する。
 * 集計ロジック（union・分母是正）は純関数 summarizeFleet（domain/tenant/device-liveness）に
 * 委譲し、ここはデータ取得と境界化（キャッシュ）だけを担う。surface ごとに別ロジックで
 * online 数が食い違う問題（#260 撤回理由 2）を構造的に防ぐ。
 *
 * 境界化（#261 AC3 → #274/#284 で恒久化）:
 *   - storage 読み: 旧 listAllDevices（テナント横断の全件読み）を廃し、**テナント一覧起点 +
 *     テナント毎の境界クエリ**（DeviceRepository.listDevicesByTenant → dynamo は tenantId の
 *     GSI1）で集約する。テナント数は契約規模で小さく、各クエリの読み取り量はテナント内の
 *     台数に比例する（無境界のパーティション全読みをしない）。
 *   - 頻度: 集計は **TTL キャッシュ越しのみ** 行う。リクエスト毎のフルスキャンはせず、
 *     走査は TTL（30 秒）に 1 回へ抑える（amortized O(1)）。
 * 死活のオンライン窓は 5 分なので 30 秒の staleness は表示品質に影響しない。
 * Lambda 等の複数インスタンスではインスタンス毎のキャッシュになるが、読み取り専用の
 * 件数集計であり一貫性要件はない。
 *
 * 認可: 本関数は認可を行わない。呼び出し route 側が担う（observability は
 * authorizePlatform=developer 限定、dashboard は admin セッション境界）。返すのは件数のみで
 * PII・token を含まない。
 */
import { summarizeFleet, type FleetSummary } from '@/domain/tenant/device-liveness';
import type { TenantId } from '@/domain/tenant/types';
import { asTenantId } from '@/domain/tenant/types';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getTenantStore } from '@/lib/tenant/store';

export type { FleetSummary } from '@/domain/tenant/device-liveness';

/** 走査を抑える TTL。オンライン窓（5 分）より十分小さく、表示鮮度と負荷のバランスを取る。 */
export const DEVICE_FLEET_CACHE_TTL_MS = 30_000;

// 集計の promise を持つ（値ではなく）。TTL 失効直後に並行リクエストが重なっても、走査は
// in-flight の 1 本に合流させる（stampede 防止）。失敗した promise はキャッシュから外し、
// 次のリクエストが再試行する（エラー自体は呼び出し元へ伝播）。
let cache: { at: number; promise: Promise<FleetSummary> } | undefined;

/**
 * Device / kiosk 両レジストリの union で端末死活を集計して返す。
 * 取得失敗は握り潰さず伝播する（監視 surface に偽の健全表示を出さない）。
 */
export function summarizeDeviceFleet(now: Date = new Date()): Promise<FleetSummary> {
  const at = now.getTime();
  // 時計の巻き戻り（at < cache.at）はキャッシュ鮮度を判定できないため信用しない。
  if (cache && at >= cache.at && at - cache.at < DEVICE_FLEET_CACHE_TTL_MS) {
    return cache.promise;
  }
  const promise = (async () => {
    const store = getTenantStore();
    const [tenants, kiosks] = await Promise.all([store.tenants.listTenants(), listKiosks()]);
    // テナント毎の境界クエリで集約（#274/#284）。未知テナントへ孤児化した Device は現れないが、
    // Device は必ず既存テナント配下に作成される（create のサイト存在チェック / adoptKiosk の
    // 既定スコープ）ため実運用では発生しない。
    const perTenant = await Promise.all(
      tenants.map((t) => store.devices.listDevicesByTenant(t.id)),
    );
    const devices = perTenant.flat();
    return summarizeFleet(
      devices,
      kiosks.map((k) => ({ id: k.id, enabled: k.enabled })),
      now,
    );
  })();
  const entry = { at, promise };
  cache = entry;
  promise.catch(() => {
    // 失敗をキャッシュに残さない（TTL の間エラーを配り続けない）。伝播は呼び出し元の await が担う。
    if (cache === entry) cache = undefined;
  });
  return promise;
}

/**
 * テナント境界付きの死活集計 (#284 item4)。actor の accessibleTenants が返す自テナント集合
 * のみを集計する（admin ダッシュボード用。developer=全テナント横断は summarizeDeviceFleet）。
 *
 * 境界化: テナント毎の境界クエリ（listDevicesByTenant）だけで、テナント一覧走査も
 * 無境界の全件読みもしない。読み取り量は自テナントの台数に比例する（/admin/kiosks の
 * 一覧 GET と同じコストクラス）ため、横断集計のような TTL キャッシュは持たない
 * （テナント別キャッシュの複雑さ > 節約。必要になればここに閉じて追加できる）。
 *
 * kiosk union の制約: レガシー kiosk レジストリ（Kiosk 型, src/domain/kiosk/types.ts）は
 * tenantId を持たず、adoptKiosk も Device を既定テナント配下へ写像する。そのため kiosk 分は
 * **既定テナント扱い**とし、スコープが既定テナントを含む場合のみ union する（単一テナント
 * 既定運用では横断集計と同値）。kiosk→tenant の実写像は別増分（#284 スコープ外）。
 */
export async function summarizeDeviceFleetForTenants(
  tenantIds: readonly TenantId[],
  now: Date = new Date(),
): Promise<FleetSummary> {
  const store = getTenantStore();
  const includeKiosks = tenantIds.includes(asTenantId(defaultTenantIdFrom()));
  const [perTenant, kiosks] = await Promise.all([
    Promise.all(tenantIds.map((t) => store.devices.listDevicesByTenant(t))),
    includeKiosks ? listKiosks() : Promise.resolve([]),
  ]);
  return summarizeFleet(
    perTenant.flat(),
    kiosks.map((k) => ({ id: k.id, enabled: k.enabled })),
    now,
  );
}

/** テスト用: キャッシュを破棄する（テスト間の集計持ち越しを防ぐ）。 */
export function __resetDeviceFleetCache(): void {
  cache = undefined;
}
