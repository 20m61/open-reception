'use client';

import { useEffect, useState } from 'react';
import type { TenantFleetSummary } from '@/domain/platform/console-summary';
import { MetricCard } from './primitives';

/**
 * プラットフォーム概況ダッシュボード (issue #90, increment 1)。
 *
 * /api/platform/dashboard（developer 専用 read API）から全テナントの稼働概況を取得して
 * 表示する。実データ未接続の運用指標は「未接続」と明示し、偽の安心を与えない。
 * 破壊的操作は本画面に置かない（read 中心）。
 */
type PendingMetric = { status: 'pending' };
type DashboardResponse = {
  fleet: TenantFleetSummary;
  metrics: Record<string, PendingMetric>;
};

const PENDING_METRICS: readonly { key: string; label: string }[] = [
  { key: 'recentErrors', label: '直近エラー' },
  { key: 'integrationErrors', label: '外部連携エラー' },
  { key: 'authErrors', label: '認証エラー' },
  { key: 'totalUsage', label: '総利用量' },
  { key: 'estimatedCost', label: '総コスト概算' },
  { key: 'maintenance', label: 'メンテナンス' },
];

export function PlatformDashboard() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/dashboard');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : '概況の取得に失敗しました。');
        return;
      }
      setData((await res.json()) as DashboardResponse);
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

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>テナント稼働</h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <MetricCard label="全テナント数" value={data ? data.fleet.total : '—'} />
        <MetricCard label="稼働中" value={data ? data.fleet.active : '—'} />
        <MetricCard label="停止中" value={data ? data.fleet.suspended : '—'} />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>
        運用指標（実データ未接続）
      </h2>
      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        {PENDING_METRICS.map((m) => (
          <MetricCard key={m.key} label={m.label} pending note="次増分で接続" />
        ))}
      </div>
    </section>
  );
}
