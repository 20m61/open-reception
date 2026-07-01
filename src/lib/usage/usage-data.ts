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
  buildUsageTrend,
  currentMonthPeriod,
  deriveUsageRates,
  previousMonthPeriod,
  summarizeUsage,
  type UsageRates,
  type UsageSummary,
  type UsageTrendPoint,
} from '@/domain/usage/usage-summary';
import {
  buildCostTrend,
  DEFAULT_COST_ASSUMPTIONS,
  estimateCost,
  type CostAssumptions,
  type CostEstimate,
  type CostTrendPoint,
} from '@/domain/usage/cost-estimate';
import { listAuditLogs, listReceptionLogsSince } from '@/lib/data-stores/reception-log-store';

/**
 * 利用量レスポンス（当月＋前月の業務単位サマリ）。
 * increment 2: 当月の派生割合（rates）と日次推移（trend）を追加。
 */
export type UsageResponse = {
  current: UsageSummary;
  previous: UsageSummary;
  /** 当月サマリから導いた割合（成功率・代替導線率など）。 */
  currentRates: UsageRates;
  /** 当月の日次推移（受付件数・接続・通話分数）。 */
  trend: UsageTrendPoint[];
};

/** 当月・前月の利用量サマリ・割合・日次推移を組み立てる。 */
export async function loadUsage(now: Date = new Date()): Promise<UsageResponse> {
  // 前月〜当月しか使わないため、前月初以降を境界クエリで取得（全件走査を避ける, #254）。
  const [receptionLogs, auditLogs] = await Promise.all([
    listReceptionLogsSince(previousMonthPeriod(now).start),
    listAuditLogs(),
  ]);
  const currentPeriod = currentMonthPeriod(now);
  const current = summarizeUsage(receptionLogs, auditLogs, currentPeriod);
  const previous = summarizeUsage(receptionLogs, auditLogs, previousMonthPeriod(now));
  return {
    current,
    previous,
    currentRates: deriveUsageRates(current),
    trend: buildUsageTrend(receptionLogs, currentPeriod),
  };
}

/** コストレスポンス（概算サマリ＋日次推移）。 */
export type CostResponse = CostEstimate & {
  /** 当月の日次コスト推移（概算）。 */
  trend: CostTrendPoint[];
};

/** 予想コスト概算を組み立てる（当月利用量×単価仮定、前月比較・日次推移つき）。 */
export async function loadCostEstimate(
  now: Date = new Date(),
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): Promise<CostResponse> {
  const { current, previous, trend } = await loadUsage(now);
  const estimate = estimateCost(current, previous, now, assumptions);
  return { ...estimate, trend: buildCostTrend(trend, assumptions) };
}
