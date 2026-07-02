/**
 * 端末の実死活（liveness）を導く純関数 (issue #261)。
 *
 * 端末は歴史的経緯で 2 レジストリに分かれている（docs/site-device-management-design.md
 * §Device/Kiosk 統合方針）:
 *   - Device（#87、テナント境界つき・heartbeat の `lastSeenAt` を持つ）… source-of-truth。
 *   - Kiosk（#18 旧レジストリ、id/displayName/enabled のみ）… Device へ段階的に寄せる。
 *
 * 死活表示はどちらで登録された端末も漏れなく数える必要がある（#260 撤回理由 1）ため、
 * 集計は両レジストリの **union（id 一致は Device 優先）** で行う。admin ダッシュボード（#86）と
 * platform オブザーバビリティ（#83/#90）は本モジュールの同一ロジックを共有し、surface 間で
 * online 数が食い違わない（#260 撤回理由 2）。I/O は持たない（データ取得と境界化・キャッシュは
 * src/lib/tenant/device-fleet.ts）。
 *
 * false-offline 方針（#261 課題 5）: heartbeat は best-effort 書込（30 秒間隔、
 * src/components/kiosk/KioskFlow.tsx の HEARTBEAT_INTERVAL_MS）。オンライン窓 5 分 = 10 周期分
 * なので、単発の書込失敗は次周期の heartbeat が実質リトライとなり false-offline にならない。
 * 明示的なリトライは持たない（失敗直後に再送しても恒常障害では無意味で、窓が吸収する）。
 */
import type { Device } from './types';

/**
 * UI 向けの稼働状態（issue #87 画面要件: オンライン / オフライン / メンテナンス中 / 無効）。
 * status + maintenance + lastSeenAt から派生する。
 */
export type DeviceConnectivity = 'online' | 'offline' | 'maintenance' | 'disabled';

/** オンライン判定の既定窓。heartbeat 間隔（30 秒）の 10 倍で、単発の書込失敗を吸収する。 */
export const DEFAULT_ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 稼働判定に必要な最小形。Device 全体を要求しない（kiosk レジストリからの射影も受ける）。
 */
export type ConnectivityInput = Pick<Device, 'status' | 'maintenance' | 'lastSeenAt'>;

/**
 * Device の稼働状態を派生する純関数 (issue #87 inc3 → #261 で domain へ移設)。
 * DeviceService（一覧/詳細）・SiteService（オンライン端末数）・fleet 集計（本モジュール）で
 * 同一ロジックを共有する。
 *   - revoked → disabled
 *   - maintenance → maintenance
 *   - lastSeenAt が窓内 → online、それ以外（窓外・未来=時計ずれ・未取得）→ offline
 */
export function deriveConnectivity(
  device: ConnectivityInput,
  now: Date,
  onlineWindowMs: number = DEFAULT_ONLINE_WINDOW_MS,
): DeviceConnectivity {
  if (device.status === 'revoked') return 'disabled';
  if (device.maintenance) return 'maintenance';
  if (!device.lastSeenAt) return 'offline';
  const age = now.getTime() - new Date(device.lastSeenAt).getTime();
  return age >= 0 && age <= onlineWindowMs ? 'online' : 'offline';
}

/** 旧 kiosk レジストリ（#18）の集計に必要な最小形。 */
export type KioskRegistryEntry = {
  id: string;
  enabled: boolean;
};

/**
 * 端末群の死活サマリ。
 *
 * **分母是正（#261 AC4）**: `total` は稼働可能端末（= online + offline）のみ。
 * disabled（失効）・maintenance（保守中）は意図的に受付を止めている状態で、
 * 分母に混ぜると「3/10 オンライン」のような希釈された数字になり異常検知が鈍る。
 * 別掲カウントとして返し、UI はそれぞれ表示する。
 */
export type FleetSummary = {
  /** 稼働可能端末数（online + offline）。オンライン率の分母。 */
  total: number;
  online: number;
  offline: number;
  /** 保守表示中（別掲・分母に含めない）。 */
  maintenance: number;
  /** 失効/無効（別掲・分母に含めない）。 */
  disabled: number;
};

/**
 * Device / kiosk 両レジストリの union で死活を集計する (issue #261 AC1)。
 *
 * - id 一致（kiosk↔Device の対応づけは id 一致: docs/site-device-management-design.md）は
 *   Device 側を採用する（heartbeat の lastSeenAt・maintenance を持つのは Device のみ）。
 *   ただし **管理上の失効はどちらのレジストリ由来でも優先**する: 旧レジストリで
 *   enabled=false にされた端末は、取り込み済み Device が active のまま heartbeat を
 *   受け続けていても disabled として数える（kiosk setEnabled → Device の逆方向同期が
 *   入るまで、失効が online 計上に打ち消される穴を塞ぐ）。
 * - kiosk のみの端末（旧 /admin/kiosks 経路で登録・未 heartbeat）は enabled から
 *   active/revoked へ射影する。lastSeenAt が無いため offline 扱いになるが、heartbeat が
 *   届き次第 Device へ取り込まれ（DeviceService.adoptKiosk）実死活に載る。
 */
export function summarizeFleet(
  devices: readonly (ConnectivityInput & { id: string })[],
  kiosks: readonly KioskRegistryEntry[],
  now: Date,
  onlineWindowMs: number = DEFAULT_ONLINE_WINDOW_MS,
): FleetSummary {
  const kioskById = new Map(kiosks.map((k) => [k.id, k]));
  const byId = new Map<string, ConnectivityInput>();
  for (const kiosk of kiosks) {
    byId.set(kiosk.id, { status: kiosk.enabled ? 'active' : 'revoked' });
  }
  for (const device of devices) {
    // Device 優先（kiosk 射影を上書き）。ただし旧レジストリでの失効は Device より強い。
    const kiosk = kioskById.get(device.id);
    byId.set(device.id, kiosk && !kiosk.enabled ? { ...device, status: 'revoked' } : device);
  }
  const counts: Record<DeviceConnectivity, number> = {
    online: 0,
    offline: 0,
    maintenance: 0,
    disabled: 0,
  };
  for (const entry of byId.values()) {
    counts[deriveConnectivity(entry, now, onlineWindowMs)] += 1;
  }
  return { total: counts.online + counts.offline, ...counts };
}
