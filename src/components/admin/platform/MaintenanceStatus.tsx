'use client';

import { useEffect, useState } from 'react';
import type { MaintenanceSummary } from '@/domain/platform/console-summary';
import { DangerActionPlaceholder, MetricCard } from './primitives';

/**
 * メンテナンス状況（read 中心） (issue #90, increment 2)。
 *
 * /api/platform/maintenance（developer 専用 read）から、メンテナンス表示中の端末を横断確認する。
 * 機密値・PII は含めない。お知らせ/障害情報は未接続として明示する。メンテナンス発動などの
 * 破壊的操作は影響範囲が広いため DangerActionPlaceholder に隔離する。
 */
type MaintenanceResponse = {
  summary: MaintenanceSummary;
  notices: { status: 'pending' };
};

export function MaintenanceStatus() {
  const [data, setData] = useState<MaintenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/maintenance');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'メンテナンス状況の取得に失敗しました。');
        return;
      }
      setData((await res.json()) as MaintenanceResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>メンテナンス</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        メンテナンス表示中の端末を横断確認します（読み取り中心）。お知らせ・障害情報の表示は
        次増分で接続します。状態の変更は影響範囲が広いため、確認・昇格・監査を伴う導線に隔離します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard
          label="メンテナンス表示中の端末"
          value={data ? data.summary.devicesInMaintenance : '—'}
        />
        <MetricCard label="お知らせ / 障害情報" pending note="次増分で接続" />
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: '6px 8px' }}>テナント</th>
            <th style={{ padding: '6px 8px' }}>端末</th>
            <th style={{ padding: '6px 8px' }}>サイト</th>
          </tr>
        </thead>
        <tbody>
          {(data?.summary.devices ?? []).map((d) => (
            <tr key={d.deviceId} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '6px 8px' }}>{d.tenantName}</td>
              <td style={{ padding: '6px 8px' }}>{d.deviceName}</td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>{d.siteId}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="メンテナンスモード発動 / お知らせ・障害情報の登録" />
      </div>
    </section>
  );
}
