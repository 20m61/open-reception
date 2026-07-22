import { createHash, createHmac } from 'node:crypto';
import type {
  AwsCostBreakdownItem,
  AwsCostFilters,
  AwsCostSummary,
  CostComponentFilter,
  CostEnvironmentFilter,
  ForecastUnavailableReason,
} from '@/domain/platform/aws-cost';
import { isCostEnvironmentFilter } from '@/domain/platform/aws-cost';

const COST_EXPLORER_ENDPOINT = 'https://ce.us-east-1.amazonaws.com/';
const COST_EXPLORER_HOST = 'ce.us-east-1.amazonaws.com';
const COST_EXPLORER_REGION = 'us-east-1';
const COST_EXPLORER_SERVICE = 'ce';
const CONTENT_TYPE = 'application/x-amz-json-1.1';
const TARGET_PREFIX = 'AWSInsightsIndexService';
const MAX_PAGES = 20;
/** GetCostForecast が「履歴不足で予測できない」ときに AWS が返すエラー種別。 */
const FORECAST_DATA_UNAVAILABLE_CODE = 'DataUnavailableException';
/** Lambda プロセス内 TTL キャッシュの有効期間 (#379: CE は 1 リクエスト $0.01 の課金が発生する)。 */
const COST_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

type CostExpression =
  | { Tags: { Key: string; Values: string[]; MatchOptions: string[] } }
  | { And: CostExpression[] };

interface CostMetric {
  Amount?: string;
  Unit?: string;
}

interface CostGroup {
  Keys?: string[];
  Metrics?: Record<string, CostMetric>;
}

interface CostResultByTime {
  Total?: Record<string, CostMetric>;
  Groups?: CostGroup[];
}

interface GetCostAndUsageResponse {
  ResultsByTime?: CostResultByTime[];
  NextPageToken?: string;
}

interface GetCostForecastResponse {
  Total?: CostMetric;
}

class CostExplorerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly awsCode?: string,
  ) {
    super(`Cost Explorer request failed (${status}${awsCode ? `: ${awsCode}` : ''})`);
    this.name = 'CostExplorerRequestError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function formatAwsDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function readAwsCredentials(): AwsCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
  };
}

function canonicalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

async function invokeCostExplorer<T>(
  operation: 'GetCostAndUsage' | 'GetCostForecast',
  payload: Record<string, unknown>,
  credentials: AwsCredentials,
  now: Date,
): Promise<T> {
  const body = JSON.stringify(payload);
  const { amzDate, dateStamp } = formatAwsDate(now);
  const target = `${TARGET_PREFIX}.${operation}`;

  const canonicalHeaderEntries: Array<[string, string]> = [
    ['content-type', CONTENT_TYPE],
    ['host', COST_EXPLORER_HOST],
    ['x-amz-date', amzDate],
    ['x-amz-target', target],
  ];
  if (credentials.sessionToken) {
    canonicalHeaderEntries.push(['x-amz-security-token', credentials.sessionToken]);
  }
  // SigV4 の SignedHeaders はバイト（コードポイント）順必須。localeCompare はロケール依存のため、
  // ヘッダを追加したときに ICU ロケール次第で並びがずれ、静かに無効な署名を作りかねない (#379)。
  canonicalHeaderEntries.sort(([a], [b]) => (a < b ? -1 : 1));

  const canonicalHeaders = canonicalHeaderEntries
    .map(([key, value]) => `${key}:${canonicalizeHeaderValue(value)}\n`)
    .join('');
  const signedHeaders = canonicalHeaderEntries.map(([key]) => key).join(';');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join('\n');

  const credentialScope = `${dateStamp}/${COST_EXPLORER_REGION}/${COST_EXPLORER_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, COST_EXPLORER_REGION);
  const serviceKey = hmac(regionKey, COST_EXPLORER_SERVICE);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE,
    'x-amz-date': amzDate,
    'x-amz-target': target,
    authorization,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const response = await fetch(COST_EXPLORER_ENDPOINT, {
    method: 'POST',
    headers,
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    let awsCode: string | undefined;
    try {
      const errorBody = (await response.json()) as { __type?: string; code?: string };
      awsCode = errorBody.__type?.split('#').pop() ?? errorBody.code;
    } catch {
      // AWS の HTML/空レスポンスでもクライアントへ本文を露出しない。
    }
    throw new CostExplorerRequestError(response.status, awsCode);
  }
  return (await response.json()) as T;
}

function dateOnlyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildCostPeriods(now: Date): {
  monthStart: string;
  actualEndExclusive: string;
  forecastStart: string;
  monthEndExclusive: string;
} {
  const monthStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const today = dateOnlyUtc(now);
  return {
    monthStart: dateOnlyUtc(monthStartDate),
    actualEndExclusive: today,
    forecastStart: today,
    monthEndExclusive: dateOnlyUtc(nextMonthDate),
  };
}

function tagExpression(key: string, value: string): CostExpression {
  return {
    Tags: {
      Key: key,
      Values: [value],
      MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
    },
  };
}

export function buildCostFilter(filters: AwsCostFilters): CostExpression {
  const expressions: CostExpression[] = [tagExpression('Project', filters.project)];
  if (filters.environment !== 'all') {
    expressions.push(tagExpression('Environment', filters.environment));
  }
  if (filters.component !== 'all') {
    expressions.push(tagExpression('Component', filters.component));
  }
  return expressions.length === 1 ? expressions[0]! : { And: expressions };
}

function normalizeGroupKey(raw: string | undefined, groupBy: 'Component' | 'Service'): string {
  if (!raw) return groupBy === 'Component' ? 'タグ未設定' : '未分類';
  if (groupBy === 'Component') {
    const prefix = 'Component$';
    const normalized = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    return normalized || 'タグ未設定';
  }
  return raw;
}

function metricAmount(metric: CostMetric | undefined): number {
  const amount = Number(metric?.Amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

async function getActualCost(
  filters: AwsCostFilters,
  periods: ReturnType<typeof buildCostPeriods>,
  credentials: AwsCredentials,
  now: Date,
): Promise<{ amount: number; currency: string; breakdown: AwsCostBreakdownItem[]; breakdownBy: 'Component' | 'Service' }> {
  const breakdownBy = filters.component === 'all' ? 'Component' : 'Service';
  if (periods.monthStart === periods.actualEndExclusive) {
    return { amount: 0, currency: 'USD', breakdown: [], breakdownBy };
  }

  const grouped = new Map<string, number>();
  let amount = 0;
  let currency = 'USD';
  let nextPageToken: string | undefined;
  let page = 0;

  do {
    const response = await invokeCostExplorer<GetCostAndUsageResponse>(
      'GetCostAndUsage',
      {
        TimePeriod: { Start: periods.monthStart, End: periods.actualEndExclusive },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost'],
        Filter: buildCostFilter(filters),
        GroupBy: [
          breakdownBy === 'Component'
            ? { Type: 'TAG', Key: 'Component' }
            : { Type: 'DIMENSION', Key: 'SERVICE' },
        ],
        ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
      },
      credentials,
      now,
    );

    for (const result of response.ResultsByTime ?? []) {
      if ((result.Groups ?? []).length > 0) {
        for (const group of result.Groups ?? []) {
          const metric = group.Metrics?.UnblendedCost;
          const groupAmount = metricAmount(metric);
          currency = metric?.Unit ?? currency;
          const key = normalizeGroupKey(group.Keys?.[0], breakdownBy);
          grouped.set(key, (grouped.get(key) ?? 0) + groupAmount);
          amount += groupAmount;
        }
      } else {
        const metric = result.Total?.UnblendedCost;
        amount += metricAmount(metric);
        currency = metric?.Unit ?? currency;
      }
    }

    nextPageToken = response.NextPageToken;
    page += 1;
  } while (nextPageToken && page < MAX_PAGES);

  if (nextPageToken) {
    throw new Error('Cost Explorer pagination exceeded the safety limit');
  }

  return {
    amount,
    currency,
    breakdownBy,
    breakdown: [...grouped.entries()]
      .map(([key, value]) => ({ key, amount: value }))
      .sort((a, b) => b.amount - a.amount),
  };
}

type ForecastOutcome = {
  remaining: number | null;
  /** 失敗理由。取得成功時は null（#379: 権限不足等を「履歴不足」と偽装しない）。 */
  unavailableReason: ForecastUnavailableReason | null;
};

async function getRemainingForecast(
  filters: AwsCostFilters,
  periods: ReturnType<typeof buildCostPeriods>,
  credentials: AwsCredentials,
  now: Date,
): Promise<ForecastOutcome> {
  try {
    const response = await invokeCostExplorer<GetCostForecastResponse>(
      'GetCostForecast',
      {
        TimePeriod: { Start: periods.forecastStart, End: periods.monthEndExclusive },
        Granularity: 'DAILY',
        Metric: 'UNBLENDED_COST',
        PredictionIntervalLevel: 80,
        Filter: buildCostFilter(filters),
      },
      credentials,
      now,
    );
    return { remaining: response.Total ? metricAmount(response.Total) : null, unavailableReason: null };
  } catch (error) {
    // 履歴不足・タグ有効化直後など、予測だけ失敗しても実績は表示する。ただし失敗理由は握り潰さず
    // 呼び出し元へ返す（#379: AccessDenied やタイムアウトを一律「履歴不足」と誤表示しない）。
    const unavailableReason: ForecastUnavailableReason =
      error instanceof CostExplorerRequestError && error.awsCode === FORECAST_DATA_UNAVAILABLE_CODE
        ? 'no_history'
        : 'request_failed';
    console.warn(
      '[platform-cost] forecast unavailable',
      unavailableReason,
      error instanceof Error ? error.message : error,
    );
    return { remaining: null, unavailableReason };
  }
}

function resolveFilters(input: {
  environment?: CostEnvironmentFilter;
  component?: CostComponentFilter;
}): AwsCostFilters {
  const configuredEnvironment = process.env.AWS_COST_ENVIRONMENT_TAG_VALUE;
  const defaultEnvironment: CostEnvironmentFilter =
    configuredEnvironment && isCostEnvironmentFilter(configuredEnvironment)
      ? configuredEnvironment
      : 'all';
  return {
    project: process.env.AWS_COST_PROJECT_TAG_VALUE || 'open-reception',
    environment: input.environment ?? defaultEnvironment,
    component: input.component ?? 'all',
  };
}

/**
 * Lambda プロセス内 TTL キャッシュ（フィルタ組み合わせ単位・5 分, #379）。
 *
 * CE は 1 リクエスト $0.01（1 view = GetCostAndUsage + GetCostForecast = $0.02）で、フィルタ操作
 * ごとに追加課金される。CloudFront の default behavior は CACHING_DISABLED（web-stack.ts）で
 * 共有キャッシュが効かないため、呼び出し元（route ハンドラ）の認可チェックの**後**にここで引く
 * プロセス内キャッシュで抑制する。認可判定より前段には置かない（未認可ユーザーへの露出を避ける）。
 * disabled / credentials_unavailable は AWS を呼ばずに確定するため対象外（キャッシュ不要）。
 */
const costSummaryCache = new Map<string, { expiresAt: number; summary: AwsCostSummary }>();

function costSummaryCacheKey(filters: AwsCostFilters): string {
  return `${filters.project}|${filters.environment}|${filters.component}`;
}

/** テスト用にキャッシュを空にする（本番コードパスからは呼ばない）。 */
export function __resetAwsCostCacheForTests(): void {
  costSummaryCache.clear();
}

export async function getAwsCostSummary(
  input: {
    environment?: CostEnvironmentFilter;
    component?: CostComponentFilter;
    now?: Date;
  } = {},
): Promise<AwsCostSummary> {
  const now = input.now ?? new Date();
  const filters = resolveFilters(input);
  const updatedAt = now.toISOString();

  if (process.env.AWS_COST_EXPLORER_ENABLED !== 'true') {
    return {
      status: 'unavailable',
      reason: 'disabled',
      message: 'AWS Cost Explorer 連携が無効です。デプロイ設定を確認してください。',
      filters,
      updatedAt,
    };
  }

  const credentials = readAwsCredentials();
  if (!credentials) {
    return {
      status: 'unavailable',
      reason: 'credentials_unavailable',
      message: 'AWS 実行ロールの認証情報を取得できません。',
      filters,
      updatedAt,
    };
  }

  const cacheKey = costSummaryCacheKey(filters);
  const cached = costSummaryCache.get(cacheKey);
  if (cached && cached.expiresAt > now.getTime()) {
    return cached.summary;
  }

  const periods = buildCostPeriods(now);
  let summary: AwsCostSummary;
  try {
    const actual = await getActualCost(filters, periods, credentials, now);
    const forecast = await getRemainingForecast(filters, periods, credentials, now);
    summary = {
      status: 'available',
      currency: actual.currency,
      period: periods,
      filters,
      actualToDate: actual.amount,
      forecastRemaining: forecast.remaining,
      monthEndEstimate:
        forecast.remaining === null ? null : actual.amount + forecast.remaining,
      breakdownBy: actual.breakdownBy,
      breakdown: actual.breakdown,
      updatedAt,
      forecastAvailable: forecast.remaining !== null,
      forecastUnavailableReason: forecast.remaining === null ? forecast.unavailableReason : null,
    };
  } catch (error) {
    console.error('[platform-cost] Cost Explorer unavailable', error instanceof Error ? error.message : error);
    summary = {
      status: 'unavailable',
      reason: 'request_failed',
      message:
        'AWS Cost Explorer からコストを取得できませんでした。権限、Cost Explorer 有効化、コスト配分タグを確認してください。',
      filters,
      updatedAt,
    };
  }

  costSummaryCache.set(cacheKey, { expiresAt: now.getTime() + COST_SUMMARY_CACHE_TTL_MS, summary });
  return summary;
}
