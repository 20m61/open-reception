'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TenantFleetSummary, TenantRow } from '@/domain/platform/console-summary';
import { DangerActionPlaceholder, MetricCard, StatusBadge } from './primitives';

/**
 * テナント一覧（テナント横断 read） (issue #90, increment 1; #90, increment 2 で詳細導線追加)。
 *
 * /api/platform/tenants（developer 専用 read API）から全テナントのメタ情報を取得して
 * 一覧表示する。inc2 で各行からテナント詳細（/platform/tenants/[tenantId]）へ遷移できる
 * read 導線を追加した。対象テナント選択 UX・有効/停止の切り替えは破壊的操作のため
 * DangerActionPlaceholder で無効化表示する（次増分で昇格・確認・監査を伴って実装）。
 */
type TenantsResponse = { summary: TenantFleetSummary; tenants: TenantRow[] };

export function TenantList() {
  const [data, setData] = useState<TenantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/tenants');
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'テナント一覧の取得に失敗しました。');
        return;
      }
      setData((await res.json()) as TenantsResponse);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>テナント</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        全テナントを横断して確認します（読み取り中心）。機密値・来訪者/担当者の個人情報は
        表示しません。対象テナント選択や有効/停止などの操作は次増分で、確認・昇格・監査を
        伴って実装します。
      </p>

      {error ? <p style={{ color: '#e0a880' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard label="全テナント数" value={data ? data.summary.total : '—'} />
        <MetricCard label="稼働中" value={data ? data.summary.active : '—'} />
        <MetricCard label="停止中" value={data ? data.summary.suspended : '—'} />
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: '6px 8px' }}>テナント</th>
            <th style={{ padding: '6px 8px' }}>slug</th>
            <th style={{ padding: '6px 8px' }}>状態</th>
            <th style={{ padding: '6px 8px' }}>更新日時</th>
          </tr>
        </thead>
        <tbody>
          {(data?.tenants ?? []).map((t) => (
            <tr key={t.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={{ padding: '6px 8px' }}>
                <Link href={`/platform/tenants/${encodeURIComponent(t.id)}`}>{t.name}</Link>
              </td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>{t.slug}</td>
              <td style={{ padding: '6px 8px' }}>
                <StatusBadge status={t.status} />
              </td>
              <td style={{ padding: '6px 8px', opacity: 0.7 }}>{t.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="テナントの有効化 / 停止・プラン/制限変更" />
      </div>
    </section>
  );
}
