'use client';

import { useCallback, useEffect, useState } from 'react';
import type { UsageRates, UsageSummary, UsageTrendPoint } from '@/domain/usage/usage-summary';
import { formatPercent as pct } from '@/domain/util/format';
import { Button } from '@/components/admin/ui';
import { UsageCard, CardGrid } from './UsageCard';
import { TrendBars, TrendSection } from './TrendBars';

/** /api/admin/usage のレスポンス型（当月＋前月、割合・日次推移つき）。 */
type UsageResponse = {
  current: UsageSummary;
  previous: UsageSummary;
  currentRates: UsageRates;
  trend: UsageTrendPoint[];
};

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; data: UsageResponse };

const DEFAULT_TENANT_ID = 'internal';

/**
 * 利用量の可視化 (issue #89, increment 1)。
 *
 * 受付件数・呼び出し成否・通話分数・代替導線を業務単位で当月・前月比較で表示する。
 * 集計 API（/api/admin/usage）から read 専用で取得する。来訪者 PII は表示しない。
 * 音声合成回数・API リクエスト数など現状ログに無い指標は「準備中」と明示する（虚値を出さない）。
 */
export function UsageManager({ tenantId = DEFAULT_TENANT_ID }: { tenantId?: string }) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch(`/api/admin/usage?tenantId=${encodeURIComponent(tenantId)}`);
      if (!res.ok) {
        setState({ phase: 'error' });
        return;
      }
      setState({ phase: 'ready', data: (await res.json()) as UsageResponse });
    } catch {
      setState({ phase: 'error' });
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="usage">
      <h1 style={{ marginTop: 0 }}>利用量</h1>
      <p style={{ opacity: 0.8, marginTop: 0, maxWidth: 680 }}>
        テナント <code>{tenantId}</code> の今月の利用状況を業務単位で表示します。来訪者の個人情報は含めません。
      </p>

      {state.phase === 'loading' ? (
        <p data-testid="usage-loading" style={{ opacity: 0.7 }}>
          利用量を読み込み中です…
        </p>
      ) : state.phase === 'error' ? (
        <div data-testid="usage-error">
          <p style={{ color: 'var(--color-danger)' }}>利用量の取得に失敗しました。</p>
          <Button variant="secondary" onClick={() => void load()}>
            再読み込み
          </Button>
        </div>
      ) : (
        <Body data={state.data} />
      )}
    </section>
  );
}

function delta(current: number, previous: number): string {
  const d = current - previous;
  if (d === 0) return '前月と同じ';
  return d > 0 ? `前月比 +${d}` : `前月比 ${d}`;
}

function Body({ data }: { data: UsageResponse }) {
  const { current, previous, currentRates, trend } = data;
  return (
    <div data-testid="usage-ready" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg, 24px)' }}>
      <CardGrid>
        <UsageCard label="受付件数" value={current.receptions} unit="件" hint={delta(current.receptions, previous.receptions)} />
        <UsageCard
          label="呼び出し成功"
          value={current.connectedCalls}
          unit="件"
          tone="success"
          hint={delta(current.connectedCalls, previous.connectedCalls)}
        />
        <UsageCard
          label="未応答・失敗"
          value={current.timeoutCalls + current.failedCalls}
          unit="件"
          tone={current.timeoutCalls + current.failedCalls > 0 ? 'warning' : 'neutral'}
          hint={`未応答 ${current.timeoutCalls} / 失敗 ${current.failedCalls}`}
        />
        <UsageCard
          label="通話分数"
          value={current.connectedCallMinutes}
          unit="分"
          hint="接続済み通話の合計（概算）"
          note="実 Vonage 課金分数との突合は次増分"
        />
        <UsageCard
          label="代替導線の利用"
          value={current.fallbackUsed}
          unit="件"
          hint={delta(current.fallbackUsed, previous.fallbackUsed)}
        />
      </CardGrid>

      <div data-testid="usage-rates">
        <h2 style={{ fontSize: '1.05rem', marginBottom: 12 }}>受付の品質（割合）</h2>
        <CardGrid>
          <UsageCard
            label="呼び出し成功率"
            value={pct(currentRates.connectedRate)}
            tone="success"
            hint="connected / 受付件数"
          />
          <UsageCard
            label="未応答率"
            value={pct(currentRates.timeoutRate)}
            tone={currentRates.timeoutRate && currentRates.timeoutRate > 0 ? 'warning' : 'neutral'}
            hint="timeout / 受付件数"
          />
          <UsageCard
            label="失敗率"
            value={pct(currentRates.failedRate)}
            tone={currentRates.failedRate && currentRates.failedRate > 0 ? 'warning' : 'neutral'}
            hint="failed / 受付件数"
          />
          <UsageCard
            label="代替導線率"
            value={pct(currentRates.fallbackRate)}
            hint="fallback / 受付件数"
          />
        </CardGrid>
      </div>

      <TrendSection title="受付件数の推移（当月・日次）" testId="usage-trend">
        <TrendBars
          data={trend.map((p) => ({ date: p.date, value: p.receptions }))}
          unit="件"
          testId="usage-trend-bars"
        />
        <p style={{ fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>
          UTC 日境界で集計しています。空の日も連続した系列として表示します。
        </p>
      </TrendSection>

      <div>
        <h2 style={{ fontSize: '1.05rem', marginBottom: 12 }}>準備中の指標</h2>
        <CardGrid>
          <UsageCard label="音声合成回数" note="記録ソース未接続。#89 次増分で集計" />
          <UsageCard label="API リクエスト数" note="記録ソース未接続。#89 次増分で集計" />
          <UsageCard label="管理画面ログイン数" note="監査アクション未定義。#89 次増分で集計" />
          <UsageCard label="外部連携失敗数" note="連携テスト結果の記録待ち。#89 次増分で集計" />
        </CardGrid>
      </div>
    </div>
  );
}
