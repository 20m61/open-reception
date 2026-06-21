/**
 * 予想コストの概算 (issue #89, increment 1)。
 *
 * 実課金 API（AWS Cost Explorer / Vonage 明細）との連携は次増分。本増分では
 * 「利用量 × 単価仮定」からの概算・月末予想を純関数で導く。出力には必ず
 * 「概算（estimate）」「予想（projection）」であることを示すフラグと、用いた単価仮定を
 * 同梱し、UI が断定的な金額に見せないようにする。
 *
 * 単価仮定の根拠は docs/usage-cost-visualization-design.md に明記する（未確定は注記）。
 * 通貨は JPY 固定（多通貨は次増分）。金額は四捨五入した整数円で扱う。
 */
import type { UsageSummary, UsageTrendPoint } from './usage-summary';

/** サービス区分（コスト内訳の軸）。docs/cost-management-tags.md の Component に対応づく。 */
export type CostService = 'vonage' | 'aws';

/** 単価仮定。すべて JPY。実課金単価ではなく design 記載の仮定値（未確定）。 */
export type CostAssumptions = {
  /** 接続済み通話 1 分あたりの Vonage 概算単価（円/分）。 */
  vonagePerCallMinute: number;
  /** 受付 1 件あたりの AWS 概算単価（Lambda/API GW/DynamoDB をならした円/件）。 */
  awsPerReception: number;
  /** しきい値警告を出す月末予想コスト（円）。0 以下なら警告しない。 */
  monthlyWarnThreshold: number;
};

/**
 * design 記載の既定単価仮定（すべて未確定の概算値）。
 * 実値が判明したら docs と本定義を同時に更新する。
 */
export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  vonagePerCallMinute: 15,
  awsPerReception: 2,
  monthlyWarnThreshold: 50000,
};

/** サービス別のコスト内訳 1 行。 */
export type CostBreakdownItem = {
  service: CostService;
  /** 表示用ラベル。 */
  label: string;
  /** この区分の概算コスト（円、今月これまで）。 */
  estimated: number;
  /** 概算の根拠（数量 × 単価）の説明文。 */
  basis: string;
};

/** 予想コストの概算結果。is* フラグで「確定値ではない」ことを明示する。 */
export type CostEstimate = {
  /** 常に true。表示は「概算」であることを必須で示す。 */
  isEstimate: true;
  currency: 'JPY';
  /** 今月これまでの概算コスト合計（円）。 */
  estimatedSoFar: number;
  /** 月末までの予想コスト合計（円）。日割りペースを月末まで線形外挿した概算。 */
  projectedMonthEnd: number;
  /** サービス別内訳（estimatedSoFar の内訳）。 */
  breakdown: CostBreakdownItem[];
  /** 前月実績（概算）との比較。前月データが無ければ null。 */
  previousMonthComparison: {
    previousEstimated: number;
    /** 今月これまで − 前月概算（円）。正なら増加。 */
    delta: number;
  } | null;
  /** しきい値警告。projectedMonthEnd が threshold を超えたら warning。 */
  threshold: {
    value: number;
    exceeded: boolean;
  } | null;
  /** 用いた単価仮定（UI で根拠として表示する）。 */
  assumptions: CostAssumptions;
};

/** 円に四捨五入する。 */
function yen(n: number): number {
  return Math.round(n);
}

/** 利用量サマリから「今月これまで」のサービス別概算コストを導く。 */
function breakdownFor(usage: UsageSummary, assumptions: CostAssumptions): CostBreakdownItem[] {
  const vonage = usage.connectedCallMinutes * assumptions.vonagePerCallMinute;
  const aws = usage.receptions * assumptions.awsPerReception;
  return [
    {
      service: 'vonage',
      label: 'Vonage（通話）',
      estimated: yen(vonage),
      basis: `通話 ${usage.connectedCallMinutes} 分 × ${assumptions.vonagePerCallMinute} 円/分`,
    },
    {
      service: 'aws',
      label: 'AWS（受付処理）',
      estimated: yen(aws),
      basis: `受付 ${usage.receptions} 件 × ${assumptions.awsPerReception} 円/件`,
    },
  ];
}

/**
 * 月末までの予想コストを日割りペースで線形外挿する（純関数）。
 *
 * 経過日数（>=1）あたりの概算コストを 1 日あたりに均し、その月の総日数を掛ける。
 * 月初や経過 0 日は estimatedSoFar をそのまま返す（0 除算を避ける）。
 *
 * @param soFar      今月これまでの概算コスト合計（円）
 * @param elapsedDays 月初からの経過日数（当日含む、>=1 を想定）
 * @param daysInMonth その月の総日数
 */
export function projectMonthEnd(soFar: number, elapsedDays: number, daysInMonth: number): number {
  if (elapsedDays <= 0 || daysInMonth <= 0) return yen(soFar);
  const perDay = soFar / elapsedDays;
  return yen(perDay * daysInMonth);
}

/** `now`（UTC）の暦月の経過日数（当日含む）と総日数を返す。 */
export function monthProgress(now: Date = new Date()): { elapsedDays: number; daysInMonth: number } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const elapsedDays = now.getUTCDate();
  return { elapsedDays, daysInMonth };
}

/**
 * 利用量サマリ（今月・前月）と単価仮定から予想コスト概算を組み立てる（純関数）。
 *
 * @param currentUsage  今月これまでの利用量
 * @param previousUsage 前月の利用量（前月比較に用いる。無ければ null）
 * @param now           基準時刻（月の経過日数算出に使う。テストで固定）
 * @param assumptions   単価仮定（既定は DEFAULT_COST_ASSUMPTIONS）
 */
export function estimateCost(
  currentUsage: UsageSummary,
  previousUsage: UsageSummary | null,
  now: Date = new Date(),
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): CostEstimate {
  const breakdown = breakdownFor(currentUsage, assumptions);
  const estimatedSoFar = breakdown.reduce((sum, item) => sum + item.estimated, 0);

  const { elapsedDays, daysInMonth } = monthProgress(now);
  const projectedMonthEnd = projectMonthEnd(estimatedSoFar, elapsedDays, daysInMonth);

  const previousMonthComparison = previousUsage
    ? (() => {
        const prev = breakdownFor(previousUsage, assumptions).reduce((s, i) => s + i.estimated, 0);
        return { previousEstimated: prev, delta: estimatedSoFar - prev };
      })()
    : null;

  const threshold =
    assumptions.monthlyWarnThreshold > 0
      ? { value: assumptions.monthlyWarnThreshold, exceeded: projectedMonthEnd > assumptions.monthlyWarnThreshold }
      : null;

  return {
    isEstimate: true,
    currency: 'JPY',
    estimatedSoFar,
    projectedMonthEnd,
    breakdown,
    previousMonthComparison,
    threshold,
    assumptions,
  };
}

/** コスト推移 1 区間（日次）。利用量推移にサービス別概算コストを重ねたもの。 */
export type CostTrendPoint = {
  /** バケット開始日（UTC、YYYY-MM-DD）。 */
  date: string;
  /** その日の Vonage 概算コスト（円）。 */
  vonage: number;
  /** その日の AWS 概算コスト（円）。 */
  aws: number;
  /** その日の概算コスト合計（円）。 */
  total: number;
};

/**
 * 利用量推移（日次）に単価仮定を掛けて日次のサービス別概算コストへ写像する（純関数）。
 *
 * 出力は概算であり、実課金とは異なる（呼び出し側が「概算」を明示する）。日次の合計を足し上げると
 * estimateCost の estimatedSoFar と一致する（同じ単価仮定・同じ丸め単位を用いる前提）。
 */
export function buildCostTrend(
  usageTrend: readonly UsageTrendPoint[],
  assumptions: CostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): CostTrendPoint[] {
  return usageTrend.map((point) => {
    const vonage = yen(point.connectedCallMinutes * assumptions.vonagePerCallMinute);
    const aws = yen(point.receptions * assumptions.awsPerReception);
    return { date: point.date, vonage, aws, total: vonage + aws };
  });
}
