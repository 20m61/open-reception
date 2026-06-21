'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CostEstimate, CostTrendPoint } from '@/domain/usage/cost-estimate';
import { Button } from '@/components/admin/ui';
import { UsageCard, CardGrid } from '../usage/UsageCard';
import { TrendBars, TrendSection } from '../usage/TrendBars';

/** /api/admin/costs のレスポンス型（概算サマリ＋日次推移）。 */
type CostResponse = CostEstimate & { trend: CostTrendPoint[] };

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; estimate: CostResponse };

const DEFAULT_TENANT_ID = 'internal';

const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

/**
 * 予想コストの可視化 (issue #89, increment 1)。
 *
 * 今月の概算コスト・月末予想・サービス別内訳・前月比較・しきい値警告を表示する。
 * すべて「概算」「予想」であることを明記し、用いた単価仮定も併記する（実課金は次増分）。
 * 集計 API（/api/admin/costs）から read 専用で取得する。
 */
export function CostManager({ tenantId = DEFAULT_TENANT_ID }: { tenantId?: string }) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch(`/api/admin/costs?tenantId=${encodeURIComponent(tenantId)}`);
      if (!res.ok) {
        setState({ phase: 'error' });
        return;
      }
      setState({ phase: 'ready', estimate: (await res.json()) as CostResponse });
    } catch {
      setState({ phase: 'error' });
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="costs">
      <h1 style={{ marginTop: 0 }}>予想コスト</h1>
      <p style={{ opacity: 0.8, marginTop: 0, maxWidth: 720 }}>
        テナント <code>{tenantId}</code> の今月のコストの<strong>概算</strong>と月末の
        <strong>予想</strong>です。実際の請求額とは異なります（実課金連携は今後対応）。
      </p>

      {state.phase === 'loading' ? (
        <p data-testid="costs-loading" style={{ opacity: 0.7 }}>
          コストを読み込み中です…
        </p>
      ) : state.phase === 'error' ? (
        <div data-testid="costs-error">
          <p style={{ color: 'var(--color-danger)' }}>コストの取得に失敗しました。</p>
          <Button variant="secondary" onClick={() => void load()}>
            再読み込み
          </Button>
        </div>
      ) : (
        <Body estimate={state.estimate} />
      )}
    </section>
  );
}

function Body({ estimate }: { estimate: CostResponse }) {
  const { estimatedSoFar, projectedMonthEnd, breakdown, previousMonthComparison, threshold, assumptions, trend } = estimate;
  const comparisonHint = previousMonthComparison
    ? `前月概算 ${yen(previousMonthComparison.previousEstimated)}（${previousMonthComparison.delta >= 0 ? '+' : ''}${yen(previousMonthComparison.delta)}）`
    : '前月データなし';

  return (
    <div data-testid="costs-ready" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg, 24px)' }}>
      <span
        data-testid="cost-disclaimer"
        style={{
          display: 'inline-block',
          alignSelf: 'flex-start',
          fontSize: '0.75rem',
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--color-surface-2)',
          opacity: 0.85,
        }}
      >
        ※ すべて「概算」「予想」値です（通貨: {estimate.currency}）
      </span>

      {threshold?.exceeded ? (
        <div
          data-testid="cost-threshold-warning"
          role="alert"
          style={{
            padding: 'var(--space-md, 16px)',
            borderRadius: 12,
            border: '1px solid var(--color-warning)',
            color: 'var(--color-warning)',
          }}
        >
          月末予想コストがしきい値 {yen(threshold.value)} を超える見込みです。利用量をご確認ください。
        </div>
      ) : null}

      <CardGrid>
        <UsageCard label="今月の概算コスト" value={yen(estimatedSoFar)} hint="今月これまでの利用量×単価仮定" />
        <UsageCard
          label="月末の予想コスト"
          value={yen(projectedMonthEnd)}
          tone={threshold?.exceeded ? 'warning' : 'neutral'}
          hint="現在のペースで月末まで外挿した概算"
        />
        <UsageCard label="前月比較" value={comparisonHint} />
      </CardGrid>

      <div>
        <h2 style={{ fontSize: '1.05rem', marginBottom: 12 }}>サービス別内訳（概算）</h2>
        <table data-testid="cost-breakdown" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-surface-2)' }}>
              <th style={cell}>サービス</th>
              <th style={cell}>概算コスト</th>
              <th style={cell}>根拠</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((item) => (
              <tr key={item.service} data-testid="cost-breakdown-row" style={{ borderBottom: '1px solid var(--color-surface-2)' }}>
                <td style={cell}>{item.label}</td>
                <td style={cell}>{yen(item.estimated)}</td>
                <td style={{ ...cell, opacity: 0.7 }}>{item.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TrendSection title="概算コストの推移（当月・日次）" testId="cost-trend">
        <TrendBars
          data={trend.map((p) => ({ date: p.date, value: p.total }))}
          unit="円"
          testId="cost-trend-bars"
        />
        <p style={{ fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>
          日次の利用量に単価仮定を掛けた<strong>概算</strong>です（UTC 日境界）。実課金とは異なります。
        </p>
      </TrendSection>

      <div data-testid="cost-assumptions" style={{ fontSize: '0.8rem', opacity: 0.7 }}>
        <h2 style={{ fontSize: '1.05rem', marginBottom: 8, opacity: 1 }}>単価仮定（未確定）</h2>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          <li>Vonage 通話: {assumptions.vonagePerCallMinute} 円/分</li>
          <li>AWS 受付処理: {assumptions.awsPerReception} 円/件</li>
          <li>警告しきい値: {yen(assumptions.monthlyWarnThreshold)}（月末予想）</li>
        </ul>
        <p style={{ marginBottom: 0 }}>
          上記は確定単価ではなく概算用の仮定値です。根拠は docs/usage-cost-visualization-design.md を参照してください。
        </p>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: '8px 12px' };
