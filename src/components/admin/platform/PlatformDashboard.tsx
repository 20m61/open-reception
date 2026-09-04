'use client';

import { useEffect, useState } from 'react';
import type { TenantFleetSummary } from '@/domain/platform/console-summary';
import type { TodayCounts } from '@/domain/reception/dashboard-summary';
import { AwsCostPanel } from './AwsCostPanel';
import { MetricCard } from '@/components/admin/ui';

/**
 * プラットフォーム概況ダッシュボード (issue #90, increment 1 / #377)。
 *
 * /api/platform/dashboard（developer 専用 read API）から全テナントの稼働概況を取得して
 * 表示する。AWS コストは独立した /api/platform/costs から取得し、Cost Explorer 側の障害が
 * 稼働概況を巻き込まないよう分離する。実データ未接続の運用指標は「未接続」と明示する。
 * 破壊的操作は本画面に置かない（read 中心）。
 */
type PendingMetric = { status: 'pending' };
type DashboardResponse = {
  fleet: TenantFleetSummary;
  receptionsToday: TodayCounts;
  metrics: Record<string, PendingMetric>;
};

const PENDING_METRICS: readonly { key: string; label: string }[] = [
  { key: 'recentErrors', label: '直近エラー' },
  { key: 'integrationErrors', label: '外部連携エラー' },
  { key: 'authErrors', label: '認証エラー' },
  { key: 'totalUsage', label: '総利用量' },
  { key: 'maintenance', label: 'メンテナンス' },
];

export function PlatformDashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/dashboard');
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '概況の取得に失敗しました。');
          return;
        }
        const body = (await res.json()) as Partial<DashboardResponse>;
        // 形が違う 200 は「読めなかった」。放置すると render で投げ、運用コンソールに
        // **来訪者向けの文言**「受付を続けられませんでした」が出る (#968 レビュー 5 周目 MAJOR-1)。
        if (body.fleet === undefined) {
          setError('概況の形式が不正です。時間をおいて再試行してください。');
          return;
        }
        setData(body as DashboardResponse);
      /*
       * 🔴 **通信そのものの失敗も「失敗」へ落とす (#968 AC2)。** `fetch` の reject や、
       * HTML が返って `res.json()` が投げるケースを拾わないと `data` も `error` も
       * `null` のままになり、指標カードは `—` を出し続ける。運用者には「まだ来ていない」
       * のか「取れなかった」のか区別が付かず、再試行の導線も読み上げも画面に無い。
       */
      } catch {
        if (!cancelled) setError('概況を取得できませんでした。通信を確認してください。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>運用ダッシュボード</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        全テナントの稼働状況を横断的に確認します。developer 専用・読み取り中心の画面です。
        対象テナントは画面上部に常時明示しています（全テナント横断）。
      </p>

      {error ? (
        <p role="alert" data-testid="platform-dashboard-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}
        </p>
      ) : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>テナント稼働</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="全テナント数" value={data ? data.fleet.total : '—'} />
        <MetricCard label="稼働中" value={data ? data.fleet.active : '—'} />
        <MetricCard label="停止中" value={data ? data.fleet.suspended : '—'} />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>本日の受付活動</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="本日の受付数" value={data?.receptionsToday?.total ?? '—'} />
        <MetricCard label="接続" value={data?.receptionsToday?.connected ?? '—'} />
        <MetricCard label="未応答" value={data?.receptionsToday?.timeout ?? '—'} />
        <MetricCard label="失敗" value={data?.receptionsToday?.failed ?? '—'} />
      </div>

      <AwsCostPanel />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        その他の運用指標（実データ未接続）
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {PENDING_METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} placeholder placeholderText="未接続" note="次増分で接続" />
        ))}
      </div>
    </section>
  );
}
