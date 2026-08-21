/**
 * チェックイン service の組み立てと受付端末の scope 解決 (#98 / #97 inc3 / #736 Gate A)。
 *
 * ## 本番形態で QR が機能していなかった
 *
 * 🔴 この配線には**独立した 2 つの欠陥**があり、どちらも「発行した QR が必ず
 * 『不明な QR』になる」に収束していた:
 *
 *   1. 予約が `MemoryReservationRepository` に載っていた。しかも**発行側と照合側で
 *      別インスタンス**。Lambda では発行を処理したインスタンスと受付端末のリクエストを
 *      処理するインスタンスが別なので、そもそも見えない
 *   2. 受付端末の scope が `dev-tenant` / `dev-site` **固定**だった。発行側は認可済みの
 *      実テナントで書くので、仮に 1 を直しても境界が一致しない
 *
 * 両方を直して初めて QR が成立する。永続化は `getBackend()`（routing 側と同じ）へ、
 * scope は端末台帳（Device）から解決する。
 *
 * ## scope が解決できないときは拒否する
 *
 * 🔴 **既定テナントへ倒さない。** scope は「その端末がどの予約を見られるか」を決めるので、
 * 未登録端末を既定テナントへ倒すと**他テナントの予約を引ける**。営業状態の解決
 * （`kiosk-gate.ts`）が既定へ fail-open するのは「通常受付を止めない」ためで、
 * あちらは境界を決めていない。ここは境界そのものなので fail-closed にする
 * （`/api/configuration/effective` が未登録端末を 403 にするのと同じ扱い）。
 */
import { asDeviceId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { DataBackedReservationRepository } from '@/lib/reservation/data-backed-repository';
import type { ReservationRepository } from '@/lib/reservation/repository';
import { getReservationTokenPepper } from '@/lib/reservation/store';
import { getTenantStore } from '@/lib/tenant/store';
import { CheckinService } from './service';

let repo: ReservationRepository | undefined;
let service: CheckinService | undefined;

function getRepo(): ReservationRepository {
  // 🔴 発行側（`ReservationService`）と**同じバックエンド**を見る。別 repo を持つと、
  // 発行した予約が受付端末から一度も見えない。
  if (!repo) repo = new DataBackedReservationRepository();
  return repo;
}

export function getCheckinService(): CheckinService {
  // pepper は発行側（ReservationService）と同一値を使う（#375）。
  if (!service) service = new CheckinService({ repo: getRepo(), pepper: getReservationTokenPepper() });
  return service;
}

/**
 * 受付端末の checkin scope を端末台帳から解決する (#736)。
 *
 * 🔴 **解決できなければ `undefined`。** 呼び出し側は拒否すること。scope は「その端末が
 * どの予約を見られるか」を決めるので、未登録端末を既定テナントへ倒すと**他テナントの
 * 予約を引ける**（`kiosk-gate.ts` の fail-open はここには当てはまらない ── あちらは
 * 境界ではなく営業状態を決めている）。
 *
 * `kioskId` は `Device.id` と一致する（`maintenance-gate.ts` / `kiosk-gate.ts` と同じ前提）。
 */
export async function resolveCheckinScope(
  kioskId: string,
): Promise<{ tenantId: TenantId; siteId: SiteId } | undefined> {
  const trimmed = kioskId.trim();
  if (!trimmed) return undefined;
  try {
    const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
    if (!device) return undefined;
    return { tenantId: device.tenantId, siteId: device.siteId };
  } catch {
    // ストア障害でも既定テナントへ倒さない（境界を緩めない）。
    return undefined;
  }
}

/** テスト用: service と in-memory データを破棄する。 */
export function __resetCheckinService(): void {
  repo = undefined;
  service = undefined;
}
