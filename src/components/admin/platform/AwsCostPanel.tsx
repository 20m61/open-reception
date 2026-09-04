'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  COST_COMPONENT_FILTERS,
  COST_ENVIRONMENT_FILTERS,
  type AwsCostBreakdownItem,
  type AwsCostSummary,
  type CostComponentFilter,
  type CostEnvironmentFilter,
  type ForecastUnavailableReason,
} from '@/domain/platform/aws-cost';
import { PLATFORM_READ_TIMEOUT_MS, isAwsCostShape, readTimeoutMessage } from './read-response';
import { DataTable, MetricCard, font, type Column } from '@/components/admin/ui';

const COMPONENT_LABELS: Record<CostComponentFilter, string> = {
  all: 'すべて',
  web: 'Web / API',
  'web-monitoring': 'Web 監視',
  'cloudfront-monitoring': 'CloudFront 監視',
  notification: '通知・音声',
  monitoring: '通知基盤監視',
};

/**
 * 予測欄の note を失敗理由で出し分ける (#379)。
 * `no_history`（タグ有効化直後・履歴不足）と `request_failed`（AccessDenied・タイムアウト等、
 * 運用者の対応が要る可能性がある）を一律「履歴不足などにより予測不可」に丸めない。
 */
function forecastNote(
  forecastAvailable: boolean,
  forecastUnavailableReason: ForecastUnavailableReason | null,
): string {
  if (forecastAvailable) return 'AWS Cost Forecast（80%予測区間）';
  if (forecastUnavailableReason === 'request_failed') {
    return '予測の取得に失敗しました（権限設定またはタイムアウトの可能性）';
  }
  return '履歴不足のため予測できません（タグ有効化直後など）';
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency,
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: value < 10 ? 2 : 0,
  }).format(value);
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'grid', gap: 5, minWidth: 170 }}>
      <span style={{ fontSize: '0.78rem', opacity: 0.68 }}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{
          minHeight: 38,
          borderRadius: 8,
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          color: 'inherit',
          padding: '0 10px',
        }}
      >
        {children}
      </select>
    </label>
  );
}

/** developer 専用の AWS Cost Explorer 可視化 (#377)。 */
/**
 * 内訳表の列定義。見出し（`breakdownBy`）も金額表記（`currency`）も応答に依るので、
 * 応答が載っている枝の中で組み立てる。
 */
function breakdownColumns(
  breakdownBy: string,
  currency: string,
): ReadonlyArray<Column<AwsCostBreakdownItem>> {
  return [
    { key: 'key', header: breakdownBy, cell: (item) => item.key },
    {
      key: 'amount',
      header: '当月実績',
      align: 'right',
      cell: (item) => formatMoney(item.amount, currency),
      cellStyle: () => ({ fontVariantNumeric: 'tabular-nums' }),
    },
  ];
}

export function AwsCostPanel() {
  // 空文字は「サーバー設定の Environment を初回既定にする」。API 応答後は実際の値を select に表示する。
  const [environment, setEnvironment] = useState<CostEnvironmentFilter | ''>('');
  const [component, setComponent] = useState<CostComponentFilter>('all');
  const [data, setData] = useState<AwsCostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (environment) params.set('environment', environment);
      params.set('component', component);
      // 明示的な再取得だけ URL を変え、通常表示・フィルター往復では private max-age=300 を活用する。
      if (refreshToken > 0) params.set('_refresh', String(refreshToken));
      try {
        const response = await fetch(`/api/platform/costs?${params.toString()}`, {
          /*
           * 🔴 **アンマウント時の中断と「返ってこない」は別の信号** (#973 AC7)。
           * `controller` はフィルタ往復・アンマウントの後始末、`AbortSignal.timeout` は
           * ハングの上限。`any` で束ねると、時間切れは `TimeoutError` として届くので
           * 下の `AbortError` 判定（黙って無視する枝）に飲まれない。
           */
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS)]),
        });
        if (!response.ok) {
          setError(
            response.status === 403
              ? 'AWSコストを閲覧する権限がありません。'
              : 'AWSコスト情報の取得に失敗しました。',
          );
          return;
        }
        const body: unknown = await response.json();
        /*
         * 形が違う 200 は「読めなかった」(#973 AC7)。`status` が未知だと画面は
         * **どちらの節も描かず、失敗表示も出ないまま空の枠**になる。
         */
        if (!isAwsCostShape(body)) {
          setError('AWSコスト情報の形式が不正です。時間をおいて再試行してください。');
          return;
        }
        setError(null);
        setData(body as AwsCostSummary);
      } catch (fetchError) {
        const name = (fetchError as Error).name;
        if (name === 'TimeoutError') setError(readTimeoutMessage('AWSコスト情報'));
        else if (name !== 'AbortError') setError('AWSコスト情報の取得に失敗しました。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [component, environment, refreshToken]);

  const selectedEnvironment = environment || data?.filters.environment || 'all';
  const updatedAt = useMemo(() => {
    if (!data) return null;
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(data.updatedAt));
  }, [data]);

  return (
    <section style={{ marginTop: 'var(--space-lg)' }} aria-labelledby="aws-cost-heading">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-md)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 id="aws-cost-heading" style={{ fontSize: '1rem', marginBottom: 6 }}>
            AWSコスト
          </h2>
          <p style={{ margin: 0, opacity: 0.68, fontSize: '0.84rem', maxWidth: 760 }}>
            Cost Explorer の請求実績をコスト配分タグで絞り込みます。Project は安全のため
            <code style={{ margin: '0 4px' }}>open-reception</code>に固定しています。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            background: 'var(--color-surface)',
            color: 'inherit',
            padding: '8px 12px',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? '取得中…' : '再取得'}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-md)',
          flexWrap: 'wrap',
          alignItems: 'end',
          marginTop: 'var(--space-md)',
          padding: 'var(--space-md)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          background: 'color-mix(in srgb, var(--color-surface) 92%, transparent)',
        }}
      >
        <div style={{ display: 'grid', gap: 5, minWidth: 180 }}>
          <span style={{ fontSize: '0.78rem', opacity: 0.68 }}>Project（固定）</span>
          <code style={{ minHeight: 38, display: 'flex', alignItems: 'center' }}>
            {data?.filters.project ?? 'open-reception'}
          </code>
        </div>
        <FilterSelect
          label="Environment"
          value={selectedEnvironment}
          disabled={loading}
          onChange={(value) => setEnvironment(value as CostEnvironmentFilter)}
        >
          {COST_ENVIRONMENT_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === 'all' ? 'すべて' : value}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Component"
          value={component}
          disabled={loading}
          onChange={(value) => setComponent(value as CostComponentFilter)}
        >
          {COST_COMPONENT_FILTERS.map((value) => (
            <option key={value} value={value}>
              {COMPONENT_LABELS[value]}
            </option>
          ))}
        </FilterSelect>
      </div>

      {error ? (
        <p role="alert" data-testid="platform-aws-cost-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}
        </p>
      ) : null}

      {!error && data?.status === 'unavailable' ? (
        <div
          role="status"
          style={{
            marginTop: 'var(--space-md)',
            border: '1px dashed var(--color-border)',
            borderRadius: 12,
            padding: 'var(--space-md)',
          }}
        >
          <strong>コスト情報を取得できません</strong>
          <p style={{ marginBottom: 0, opacity: 0.75 }}>{data.message}</p>
        </div>
      ) : null}

      {!error && data?.status === 'available' ? (
        <>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-md)',
              flexWrap: 'wrap',
              marginTop: 'var(--space-md)',
            }}
          >
            <MetricCard
              label="当月実績"
              value={formatMoney(data.actualToDate, data.currency)}
              note={`${data.period.monthStart}〜${data.period.actualEndExclusive}（終了日を含まない）`}
            />
            <MetricCard
              label="残期間予測"
              value={formatMoney(data.forecastRemaining, data.currency)}
              note={forecastNote(data.forecastAvailable, data.forecastUnavailableReason)}
            />
            <MetricCard
              label="月末見込み"
              value={formatMoney(data.monthEndEstimate, data.currency)}
              note="当月実績 + 残期間予測"
            />
          </div>

          <div
            style={{
              marginTop: 'var(--space-md)',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
            }}
          >
            <div style={{ padding: 'var(--space-md)', borderBottom: '1px solid var(--color-border)' }}>
              <strong>{data.breakdownBy === 'Component' ? 'Component別内訳' : 'AWSサービス別内訳'}</strong>
            </div>
            {/*
              生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
              `DataTable` が自前で持つので、外側の `overflowX` は外す（二重スクロールにしない）。
              ここは `data` が載ってからしか描かないので、`loaded` は常に真・`failed` は常に偽。
            */}
            <DataTable
              testId="aws-cost-breakdown"
              scrollRegionLabel="コスト内訳"
              columns={breakdownColumns(data.breakdownBy, data.currency)}
              rows={data.breakdown}
              rowKey={(item) => item.key}
              loaded
              failed={false}
              emptyMessage="対象期間のコストデータはまだありません。"
            />
          </div>
        </>
      ) : null}

      <p style={{ opacity: 0.56, fontSize: font.caption, marginTop: 10 }}>
        AWS請求データはリアルタイムではなく、コスト配分タグの有効化・反映にも時間がかかります。
        {updatedAt ? ` 最終取得: ${updatedAt}` : ''}
      </p>
    </section>
  );
}
