'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { TenantFleetSummary, TenantRow } from '@/domain/platform/console-summary';
import { DangerActionPlaceholder } from './primitives';
import { DataTable, MetricCard, StatusBadge, type Column } from '@/components/admin/ui';
import { tenantStatusState } from '../state-vocabulary';

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
      try {
        const res = await fetch('/api/platform/tenants');
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'テナント一覧の取得に失敗しました。');
          return;
        }
        setData((await res.json()) as TenantsResponse);
      /*
       * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
       * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
       * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
       * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
       * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
       */
      } catch {
        if (!cancelled) setError('テナント一覧の取得に失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const columns: ReadonlyArray<Column<TenantRow>> = [
    {
      key: 'name',
      header: 'テナント',
      cell: (t) => <Link href={`/platform/tenants/${encodeURIComponent(t.id)}`}>{t.name}</Link>,
    },
    { key: 'slug', header: 'slug', cell: (t) => t.slug, cellStyle: () => ({ opacity: 0.7 }) },
    {
      key: 'status',
      header: '状態',
      cell: (t) => (
        <StatusBadge status={tenantStatusState(t.status).status} label={tenantStatusState(t.status).label} />
      ),
    },
    { key: 'updatedAt', header: '更新日時', cell: (t) => t.updatedAt, cellStyle: () => ({ opacity: 0.7 }) },
  ];

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>テナント</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        全テナントを横断して確認します（読み取り中心）。機密値・来訪者/担当者の個人情報は
        表示しません。対象テナント選択や有効/停止などの操作は次増分で、確認・昇格・監査を
        伴って実装します。
      </p>

      {error ? <p role="alert" style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard label="全テナント数" value={data ? data.summary.total : '—'} />
        <MetricCard label="稼働中" value={data ? data.summary.active : '—'} />
        <MetricCard label="停止中" value={data ? data.summary.suspended : '—'} />
      </div>

      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 の `TableBodyState` と同じ判断を部品側で行う）。
      */}
      <DataTable
        testId="platform-tenants"
        scrollRegionLabel="テナント一覧"
        columns={columns}
        rows={data?.tenants ?? []}
        rowKey={(t) => t.id}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="テナントがありません。"
        failureMessage="テナント一覧を読み込めませんでした。"
      />

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="テナントの有効化 / 停止・プラン/制限変更" />
      </div>
    </section>
  );
}
