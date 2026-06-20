/**
 * 利用量・コスト read API のデータ組み立て (issue #89, increment 1)。
 *
 * 既存ログストア（reception-log-store）から受付履歴・監査ログを読み、純関数
 * （domain/usage）で当月・前月の利用量サマリと予想コスト概算を導く。来訪者 PII は
 * 一切扱わない（ReceptionLog / AuditLog は元々 PII を持たない）。
 *
 * テナント境界注記: 現状の mock ログストアはテナント分割されていない（#80 のデータ層
 * 分割は別トラック）。本増分では API 入口で canAccessTenant により参照可否を判定し、
 * 集計対象は単一ストア全体とする。ストアのテナント分割後に tenantId でフィルタする
 * （docs/usage-cost-visualization-design.md に明記）。
 */
import {
  currentMonthPeriod,
  previousMonthPeriod,
  summarizeUsage,
  type UsageSummary,
} from '@/domain/usage/usage-summary';
import {
  DEFAULT_COST_ASSUMPTIONS,
  estimateCost,
  type CostAssumptions,
  type CostEstimate,
} from '@/domain/usage/cost-estimate';
import { listAuditLogs, listReceptionLogs } from '@/lib/mock-backend/reception-log-store';

/** 利用量レスポンス（当月＋前月の業務単位サマリ）。 */
export type UsageResponse = {
  current: UsageSummary;
  previous: UsageSummary;
};

/** 当月・前月の利用量サマリを組み立てる。 */
export async function loadUsage(now: Date = new Date()): Promise<UsageResponse> {
  const [receptionLogs, auditLogs] = await Promise.all([listReceptionLogs(), listAuditLogs()]);
  const current = summarizeUsage(receptionLogs, auditLogs, currentMonthPeriod(now));
  const previous = summarizeUsage(receptionLogs, auditLogs, previousMonthPeriod(now));
  return { current, previous };
}

/** 予想コスト概算を組み立てる（当月利用量×単価仮定、前月比較つき）。 */
export async function loadCostEstimate(
  now: Date = new Date(),
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): Promise<CostEstimate> {
  const { current, previous } = await loadUsage(now);
  return estimateCost(current, previous, now, assumptions);
}
