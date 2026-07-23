/**
 * チェックイン service の組み立てと受付端末の scope 解決 (issue #98, increment 1)。
 *
 * route から使う CheckinService を 1 つ生成して共有する。本増分の永続化は in-memory。
 *
 * 既知の制約（docs/qr-checkin-design.md §4）:
 *   - kiosk セッションは現状 kioskId のみを持ち、kiosk→tenant/site 写像は未配線
 *     （#80 / #18 の後続）。#97 request.ts が actor 解決を暫定実装にしているのと同様、
 *     inc1 では checkin scope を dev 既定に解決する暫定実装とする。
 *   - #97 の予約は ReservationService が私有する in-memory repo に保持される。本増分では
 *     checkin 用に独立した in-memory repo を持つ（dev seed で疎通を確認できる）。両者を
 *     同一バックエンドで共有する配線は #97 increment 3（DynamoDB / getBackend()）で行う。
 *     token が高エントロピーかつ tenant/site 境界チェックが二重防御として効く。
 */
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { MemoryReservationRepository } from '@/lib/reservation/memory-repository';
import type { ReservationRepository } from '@/lib/reservation/repository';
import { getReservationTokenPepper } from '@/lib/reservation/store';
import { CheckinService } from './service';

/** inc1 の暫定 dev scope。実 kiosk→site 解決は次増分で配線する。 */
export const DEV_CHECKIN_TENANT_ID: TenantId = asTenantId('dev-tenant');
export const DEV_CHECKIN_SITE_ID: SiteId = asSiteId('dev-site');

let repo: ReservationRepository | undefined;
let service: CheckinService | undefined;

function getRepo(): ReservationRepository {
  if (!repo) repo = new MemoryReservationRepository();
  return repo;
}

export function getCheckinService(): CheckinService {
  // pepper は発行側（ReservationService）と同一値を使う（#375）。
  if (!service) service = new CheckinService({ repo: getRepo(), pepper: getReservationTokenPepper() });
  return service;
}

/**
 * 受付端末の checkin scope を解決する。inc1 は kioskId に依らず dev scope を返す暫定実装。
 * 実 kiosk→tenant/site 解決は increment 3 で配線する。
 */
export function resolveCheckinScope(_kioskId: string): { tenantId: TenantId; siteId: SiteId } {
  return { tenantId: DEV_CHECKIN_TENANT_ID, siteId: DEV_CHECKIN_SITE_ID };
}

/** テスト用: service と in-memory データを破棄する。 */
export function __resetCheckinService(): void {
  repo = undefined;
  service = undefined;
}
