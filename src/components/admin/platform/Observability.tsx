'use client';

import { useEffect, useState } from 'react';
import type { MaskedAuditRow } from '@/domain/platform/console-summary';
import { formatPercent } from '@/domain/util/format';
import { DataTable, MetricCard, type Column } from '@/components/admin/ui';
import { enablementState } from '../state-vocabulary';

/**
 * 可観測性（read 中心） (issue #90, increment 2)。
 *
 * /api/platform/observability（developer 専用 read）から、接続済みの範囲（外部連携の接続結果・
 * マスク済み直近アクティビティ）を表示する。指標（エラー率・レイテンシ等）は未接続として
 * 「未接続」を明示する。直近ログは actor をマスク済みで PII を露出しない。
 */
type Integration = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  lastResult: 'untested' | 'success' | 'failure';
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};
type ObservabilityResponse = {
  integrations: Integration[];
  recentActivity: MaskedAuditRow[];
  reception: { receptions: number; successRate: number | null; callFailures: number; noAnswer: number };
  // 端末の実死活 (#261)。total は稼働可能端末のみ（= online + offline）。maintenance/disabled は別掲。
  devices: { total: number; online: number; offline: number; maintenance: number; disabled: number };
  metrics: Record<string, { status: 'pending' }>;
};

const PENDING_METRICS: readonly { key: string; label: string }[] = [
  { key: 'errorRate', label: 'エラー率' },
  { key: 'authErrors', label: '認証エラー' },
  { key: 'lambdaApiErrors', label: 'Lambda / API エラー' },
  { key: 'latency', label: 'レイテンシ' },
  { key: 'alerts', label: 'アラート履歴' },
];

const RESULT_LABEL: Record<Integration['lastResult'], string> = {
  untested: '未テスト',
  success: '成功',
  failure: '失敗',
};

const INTEGRATION_COLUMNS: ReadonlyArray<Column<Integration>> = [
  { key: 'label', header: '連携', cell: (i) => i.label },
  { key: 'configured', header: '設定', cell: (i) => (i.configured ? '済' : '未'), cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'enabled', header: '有効', cell: (i) => enablementState(i.enabled).label, cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'lastResult', header: '直近結果', cell: (i) => RESULT_LABEL[i.lastResult], cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'summary', header: '要約', cell: (i) => i.lastErrorSummary ?? '-', cellStyle: () => ({ opacity: 0.6 }) },
];

const ACTIVITY_COLUMNS: ReadonlyArray<Column<MaskedAuditRow>> = [
  { key: 'at', header: '日時', cell: (r) => r.at, cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'action', header: '操作', cell: (r) => r.action },
  { key: 'actor', header: '主体', cell: (r) => r.actor, cellStyle: () => ({ opacity: 0.7 }) },
  {
    key: 'target',
    header: '対象',
    cell: (r) => (
      <>
        {r.targetType ?? '-'}
        {r.targetId ? <span style={{ opacity: 0.6 }}> {r.targetId}</span> : null}
      </>
    ),
    cellStyle: () => ({ opacity: 0.7 }),
  },
];

export function Observability() {
  const [data, setData] = useState<ObservabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/observability');
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '可観測性情報の取得に失敗しました。');
          return;
        }
        setData((await res.json()) as ObservabilityResponse);
      /*
       * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
       * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
       * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
       * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
       * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
       */
      } catch {
        if (!cancelled) setError('可観測性情報の取得に失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>可観測性</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        外部連携の接続結果と直近アクティビティを横断確認します（読み取り専用）。直近ログは
        マスク済みで個人情報を露出しません。エラー率・レイテンシ等の指標は次増分で接続します。
      </p>

      {error ? <p role="alert" style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>外部連携の接続状態</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 で生 `<tbody>` に置いていた 3 状態の判断を、部品側へ移したもの）。
      */}
      <DataTable
        testId="platform-observability-integrations"
        scrollRegionLabel="外部連携の接続状態"
        columns={INTEGRATION_COLUMNS}
        rows={data?.integrations ?? []}
        rowKey={(i) => i.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="連携がありません。"
        failureMessage="外部連携の接続状態を読み込めませんでした。"
      />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>受付・端末（今月・実データ）</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="受付成功率" value={data ? formatPercent(data.reception?.successRate ?? null) : '—'} />
        <MetricCard label="今月の受付数" value={data?.reception?.receptions ?? '—'} />
        <MetricCard label="通話失敗数" value={data?.reception?.callFailures ?? '—'} />
        <MetricCard label="未応答" value={data?.reception?.noAnswer ?? '—'} />
        {/* 実死活 (#261): 直近 5 分に heartbeat を受信した端末数。分母は稼働可能端末のみ。 */}
        <MetricCard
          label="端末オンライン"
          value={data?.devices ? `${data.devices.online}/${data.devices.total}` : '—'}
        />
        <MetricCard label="オフライン" value={data?.devices?.offline ?? '—'} />
        {/* 保守/無効は意図的な停止のため分母から除外し別掲する（希釈防止, #261 AC4）。 */}
        <MetricCard label="メンテナンス中" value={data?.devices?.maintenance ?? '—'} />
        <MetricCard label="無効な端末" value={data?.devices?.disabled ?? '—'} />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>指標（実データ未接続）</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {PENDING_METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} placeholder placeholderText="未接続" note="次増分で接続" />
        ))}
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        直近アクティビティ（マスク済み）
      </h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 で生 `<tbody>` に置いていた 3 状態の判断を、部品側へ移したもの）。
      */}
      <DataTable
        testId="platform-recent-activity"
        scrollRegionLabel="直近アクティビティ"
        columns={ACTIVITY_COLUMNS}
        rows={data?.recentActivity ?? []}
        rowKey={(r) => r.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="直近の操作はありません。"
        failureMessage="直近アクティビティを読み込めませんでした。"
      />
    </section>
  );
}
