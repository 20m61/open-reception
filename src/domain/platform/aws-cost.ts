export const COST_ENVIRONMENT_FILTERS = ['all', 'dev', 'staging', 'prod'] as const;
export type CostEnvironmentFilter = (typeof COST_ENVIRONMENT_FILTERS)[number];

/** CDK の Stack 単位 Component タグ。新しい Stack を追加したらここにも明示的に追加する。 */
export const COST_COMPONENT_FILTERS = [
  'all',
  'web',
  'web-monitoring',
  'cloudfront-monitoring',
  'notification',
  'monitoring',
] as const;
export type CostComponentFilter = (typeof COST_COMPONENT_FILTERS)[number];

export type AwsCostUnavailableReason =
  | 'disabled'
  | 'credentials_unavailable'
  | 'request_failed';

export type AwsCostBreakdownItem = {
  key: string;
  amount: number;
};

export type AwsCostFilters = {
  /** Project はクライアントから変更できず、常にサーバー設定値（既定 open-reception）。 */
  project: string;
  environment: CostEnvironmentFilter;
  component: CostComponentFilter;
};

/**
 * 予測（GetCostForecast）が失敗した理由 (#379)。
 * - `no_history`: AWS が `DataUnavailableException` を返した（履歴不足・タグ有効化直後など、
 *   運用者の対応不要）。
 * - `request_failed`: それ以外の失敗（AccessDenied・タイムアウト・スロットリング等）。
 *   権限設定漏れなど運用者の対応が必要な可能性がある。
 * `forecastAvailable: true` のときは常に `null`。
 */
export type ForecastUnavailableReason = 'no_history' | 'request_failed';

export type AwsCostAvailable = {
  status: 'available';
  currency: string;
  period: {
    monthStart: string;
    actualEndExclusive: string;
    forecastStart: string;
    monthEndExclusive: string;
  };
  filters: AwsCostFilters;
  actualToDate: number;
  forecastRemaining: number | null;
  monthEndEstimate: number | null;
  breakdownBy: 'Component' | 'Service';
  breakdown: AwsCostBreakdownItem[];
  updatedAt: string;
  forecastAvailable: boolean;
  /** forecastAvailable=false のときの失敗理由。true のときは null。 */
  forecastUnavailableReason: ForecastUnavailableReason | null;
};

export type AwsCostUnavailable = {
  status: 'unavailable';
  reason: AwsCostUnavailableReason;
  message: string;
  filters: AwsCostFilters;
  updatedAt: string;
};

export type AwsCostSummary = AwsCostAvailable | AwsCostUnavailable;

export function isCostEnvironmentFilter(value: string): value is CostEnvironmentFilter {
  return (COST_ENVIRONMENT_FILTERS as readonly string[]).includes(value);
}

export function isCostComponentFilter(value: string): value is CostComponentFilter {
  return (COST_COMPONENT_FILTERS as readonly string[]).includes(value);
}
