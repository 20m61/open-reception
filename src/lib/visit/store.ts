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
 * kiosk→tenant/site 写像（docs/checkout-stay-design.md §5、#98 と同方針）:
 *   - kiosk セッションは kioskId のみを持つ。kioskId は Device.id と一致するため
 *     （device-service.ts consumeEnrollment / adoptKiosk）、Device レジストリを
 *     `findDeviceById(kioskId)` で引き、その端末が属する tenant/site を scope として返す。
 *   - 対応 Device が無い kiosk（旧レジストリのみ・未 adopt）は dev 既定 scope へフォールバック
 *     する（後方互換。従来は全 kiosk が無条件に dev 既定へ落ちていた）。
 */
import { asDeviceId, asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { appendAdminAudit, appendAuditLog } from '@/lib/data-stores/reception-log-store';
import { getTenantStore } from '@/lib/tenant/store';
import { DataBackedStayRepository, type StayRepository } from './repository';
import { KioskStayService } from './kiosk-service';
import { StayService } from './service';

/**
 * 未解決 kiosk 用の dev 既定 scope。対応 Device が無い kiosk（旧レジストリのみ・未 adopt）
 * のフォールバック先。単一テナント dev では kiosk-dev が seed Device 経由で internal/default-site
 * に解決されるため、ここへ落ちるのは未登録端末のみ。
 */
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
 * 受付端末の stay scope を解決する。kioskId（= Device.id）を Device レジストリで引き、
 * その端末が属する tenant/site を返す。対応 Device が無い kiosk は dev 既定へフォールバックする。
 *
 * scope は **サーバ権威**（kiosk セッションの kioskId のみが入力）で、クライアント入力に
 * 依存しない。これによりマルチテナントでも在館記録が端末の実 scope に収まる（#342/#348 の
 * 所有権チェックと合わせて真のマルチテナント化）。
 */
export async function resolveStayScope(
  kioskId: string,
): Promise<{ tenantId: TenantId; siteId: SiteId }> {
  const trimmed = kioskId.trim();
  if (trimmed !== '') {
    const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
    if (device) return { tenantId: device.tenantId, siteId: device.siteId };
  }
  return { tenantId: DEV_STAY_TENANT_ID, siteId: DEV_STAY_SITE_ID };
}

/** テスト用: リポジトリ/サービスのシングルトンを破棄する（次回 getter で再生成）。 */
export function __resetStayServices(): void {
  repository = undefined;
  adminService = undefined;
  kioskService = undefined;
}
