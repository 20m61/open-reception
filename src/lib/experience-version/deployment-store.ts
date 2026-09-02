/**
 * 端末の構成反映レポートの永続化 (issue #420 increment 3)。
 *
 * 端末は heartbeat で「いま読み込んでいる版」を報告する。サーバはそれを保存し、公開中の版
 * （desired）と突き合わせて反映状況を出す（判定は `domain/experience-version/deployment.ts`）。
 *
 * **報告される指紋は内容の指紋**（`computeSectionsHash` = 版のスナップショット指紋）。
 * API 応答の `configHash` は context（端末 ID）を含むため端末ごとに違い、管理側で「期待値」を
 * 1 つに決められない。そのため端末は `version.contentHash` を報告する。
 *
 * 報告は best-effort（heartbeat 応答を止めない）。書き込みが落ちても次周期が実質リトライになる。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { SiteId, TenantId } from '@/domain/tenant/types';

export const DEPLOYMENT_REPORT_COLLECTION = 'kiosk_config_deployment';

const REPORT_LIST_LIMIT = 1000;

/** 1 端末分の報告。id = kioskId。 */
export type DeploymentReport = {
  id: string;
  tenantId: TenantId;
  siteId: SiteId;
  /** `<tenantId>:<siteId>`。不変なので listByIndex の対象にできる。 */
  scope: string;
  loadedRevision?: number;
  loadedConfigHash?: string;
  lastAttemptAt?: string;
  errorCode?: string;
  errorRevision?: number;
  reportedAt: string;
};

export function scopeKey(tenantId: TenantId, siteId: SiteId): string {
  return `${String(tenantId)}:${String(siteId)}`;
}

function collection(): Collection<DeploymentReport> {
  return getBackend().collection<DeploymentReport>(DEPLOYMENT_REPORT_COLLECTION, {
    indexedField: 'scope',
  });
}

export type DeploymentReportInput = {
  kioskId: string;
  tenantId: TenantId;
  siteId: SiteId;
  loadedRevision?: number;
  loadedConfigHash?: string;
  errorCode?: string;
  errorRevision?: number;
  reportedAt: string;
};

/**
 * 端末の報告を記録する（同一端末は上書き）。
 *
 * 読込エラーの報告は**成功報告を消さない**。端末は last-known-good で稼働し続けるため、
 * 「いまどの版で動いているか（loaded）」と「どの版の読込で失敗したか（error）」は同時に
 * 意味を持つ。エラーのみの報告で loaded を消すと、稼働中の版が分からなくなる。
 */
export async function recordDeploymentReport(input: DeploymentReportInput): Promise<void> {
  const col = collection();
  const previous = await col.get(input.kioskId);

  await col.put({
    id: input.kioskId,
    tenantId: input.tenantId,
    siteId: input.siteId,
    scope: scopeKey(input.tenantId, input.siteId),
    loadedRevision: input.loadedRevision ?? previous?.loadedRevision,
    loadedConfigHash: input.loadedConfigHash ?? previous?.loadedConfigHash,
    // 失敗報告があった時刻。成功報告では過去の失敗時刻を引き継がない（解消済みとみなす）。
    lastAttemptAt: input.errorCode ? input.reportedAt : undefined,
    errorCode: input.errorCode,
    errorRevision: input.errorRevision,
    reportedAt: input.reportedAt,
  });
}

/** 拠点配下の全報告。 */
export async function listDeploymentReports(
  tenantId: TenantId,
  siteId: SiteId,
): Promise<DeploymentReport[]> {
  return collection().listByIndex(scopeKey(tenantId, siteId), { limit: REPORT_LIST_LIMIT });
}
