'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TenantDetail as TenantDetailData, TenantSiteRow } from '@/domain/platform/console-summary';
import type { TenantLifecycleAction } from '@/domain/platform/tenant-lifecycle';
import { DangerActionButton } from '@/components/admin/danger/DangerActionButton';
import { DataTable, MetricCard, StatusBadge, type Column } from '@/components/admin/ui';
import { siteStatusState, tenantStatusState } from '../state-vocabulary';

/**
 * テナント詳細（テナント横断 read + 有効/停止操作） (issue #90)。
 *
 * /api/platform/tenants/[tenantId] から、テナントのメタ情報と配下のサイト/端末の数・状態を
 * 取得して表示する。機密値・来訪者/担当者 PII は含めない。有効/停止は破壊的操作のため
 * DangerActionButton（影響範囲ack + 理由入力 + 二段確認）で隔離し、PATCH で実行する。
 */
type DetailResponse = { detail: TenantDetailData };

export function TenantDetail({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<TenantDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}`);
      if (!res.ok) {
        setError(
          res.status === 403
            ? 'この画面の閲覧権限がありません。'
            : res.status === 404
              ? 'テナントが見つかりません。'
              : 'テナント詳細の取得に失敗しました。',
        );
        return;
      }
      setError(null);
      setData(((await res.json()) as DetailResponse).detail);
    /*
     * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
     * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
     * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
     * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
     * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
     */
    } catch {
      setError('テナント詳細の取得に失敗しました。');
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runLifecycle = useCallback(
    async (action: TenantLifecycleAction, reason?: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, reason }),
        });
        if (res.ok) await load();
        else setError('操作に失敗しました。');
      } finally {
        setBusy(false);
      }
    },
    [tenantId, load],
  );

  const siteColumns: ReadonlyArray<Column<TenantSiteRow>> = [
    { key: 'name', header: 'サイト', cell: (s) => s.name },
    {
      key: 'status',
      header: '状態',
      cell: (s) => <StatusBadge status={siteStatusState(s.status).status} label={siteStatusState(s.status).label} />,
    },
    { key: 'deviceCount', header: '端末数', cell: (s) => s.deviceCount, cellStyle: () => ({ opacity: 0.8 }) },
    {
      key: 'activeDeviceCount',
      header: '稼働中',
      cell: (s) => s.activeDeviceCount,
      cellStyle: () => ({ opacity: 0.8 }),
    },
  ];

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>
        テナント詳細{data ? `: ${data.name}` : ''}
        {data ? (
          <span style={{ marginLeft: 'var(--space-md)' }}>
            <StatusBadge status={tenantStatusState(data.status).status} label={tenantStatusState(data.status).label} />
          </span>
        ) : null}
      </h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        対象テナントのサイト/端末の構成と状態を確認します（読み取り中心）。機密値・個人情報は
        表示しません。有効/停止は破壊的操作のため、影響範囲の確認と理由入力を伴う確認フローで実行します。
      </p>

      {error ? <p role="alert" style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard label="slug" value={data ? data.slug : '—'} />
        <MetricCard label="サイト数" value={data ? data.siteCount : '—'} />
        <MetricCard label="端末数" value={data ? data.deviceCount : '—'} />
        <MetricCard label="稼働中端末" value={data ? data.activeDeviceCount : '—'} />
        <MetricCard label="メンテナンス中端末" value={data ? data.maintenanceDeviceCount : '—'} />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>サイト</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 の `TableBodyState` と同じ判断を部品側で行う）。
      */}
      <DataTable
        testId="platform-tenant-sites"
        scrollRegionLabel="サイト一覧"
        columns={siteColumns}
        rows={data?.sites ?? []}
        rowKey={(s) => s.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="このテナントに拠点がありません。"
        failureMessage="サイト一覧を読み込めませんでした。"
      />

      {data ? (
        <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
          <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>危険な操作</h2>
          <DangerActionButton
            label={data.status === 'active' ? 'このテナントを停止する' : 'このテナントを有効化する'}
            requirement={{ requireImpactAck: true, requireReason: true }}
            impactSummary={
              data.status === 'active'
                ? '停止すると当該テナントの受付・管理操作ができなくなります（データは保持されます）。'
                : '有効化すると当該テナントの受付・管理操作が再開されます。'
            }
            busy={busy}
            onConfirm={({ reason }) =>
              void runLifecycle(data.status === 'active' ? 'suspend' : 'activate', reason)
            }
          />
        </div>
      ) : null}
    </section>
  );
}
