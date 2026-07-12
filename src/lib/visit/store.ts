/**
 * 滞在サービスの組み立てと受付端末の scope 解決 (issue #102, increment 1)。
 *
 * 管理画面用 StayService と受付端末用 KioskStayService を 1 つずつ生成して共有する。
 * 両者は getBackend ベースの同一リポジトリ（DataBackedStayRepository、§9.2 の
 * プロセス共有ファクトリ getStayRepository）を使うため、端末で退館した滞在が
 * 管理画面の在館一覧へ反映される。
 *
 * 監査は既存の appendAdminAudit（PII なし）を使う。
 *
 * 既知の制約（docs/checkout-stay-design.md §5、#98 と同方針）:
 *   - kiosk セッションは kioskId のみを持ち、kiosk→tenant/site 写像は未配線。
 *     inc1 では dev 既定 scope を返す暫定実装とする（実解決は後続増分）。
 */
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { appendAdminAudit, appendAuditLog } from '@/lib/data-stores/reception-log-store';
import { DataBackedStayRepository, type StayRepository } from './repository';
import { KioskStayService } from './kiosk-service';
import { StayService } from './service';

/** inc1 の暫定 dev scope。実 kiosk→site 解決は後続増分で配線する。 */
export const DEV_STAY_TENANT_ID: TenantId = asTenantId('dev-tenant');
export const DEV_STAY_SITE_ID: SiteId = asSiteId('dev-site');

let repository: StayRepository | undefined;
let adminService: StayService | undefined;
let kioskService: KioskStayService | undefined;

/** プロセス共有の StayRepository（§9.2 のファクトリ）。 */
export function getStayRepository(): StayRepository {
  if (!repository) {
    repository = new DataBackedStayRepository();
  }
  return repository;
}

export function getStayService(): StayService {
  if (!adminService) {
    adminService = new StayService({
      repo: getStayRepository(),
      appendAudit: appendAdminAudit,
    });
  }
  return adminService;
}

export function getKioskStayService(): KioskStayService {
  if (!kioskService) {
    // 受付完了からの自動起票 (#342) の監査（stay.updated・PII なし）を注入する。
    kioskService = new KioskStayService({ repo: getStayRepository(), appendAudit: appendAuditLog });
  }
  return kioskService;
}

/**
 * 受付端末の stay scope を解決する。inc1 は kioskId に依らず dev scope を返す暫定実装。
 * 実 kiosk→tenant/site 解決は後続増分で配線する。
 */
export function resolveStayScope(_kioskId: string): { tenantId: TenantId; siteId: SiteId } {
  return { tenantId: DEV_STAY_TENANT_ID, siteId: DEV_STAY_SITE_ID };
}

/** テスト用: リポジトリ/サービスのシングルトンを破棄する（次回 getter で再生成）。 */
export function __resetStayServices(): void {
  repository = undefined;
  adminService = undefined;
  kioskService = undefined;
}
