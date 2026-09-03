'use client';

import { useEffect, useState } from 'react';
import type {
  UpdateScope,
  UpdateState,
  UpdateStatusRow,
  UpdateStatusSummary,
} from '@/domain/platform/update-status';
import { DangerActionPlaceholder } from './primitives';
import { DataTable, MetricCard, type Column } from '@/components/admin/ui';

/**
 * アップデート状況（read 中心） (issue #83 AC6)。
 *
 * /api/platform/updates（developer 専用 read）から、Tenant/Site/Device 単位のアップデート状況を
 * 横断確認する。機密値・PII・操作者識別子は含めない。対象テナント選択中は全体影響＋当該テナントに
 * 絞り込まれる。実際の更新実行（デプロイ/ロールバック）は影響範囲が広いため、確認・昇格・監査を
 * 伴う導線（DangerActionPlaceholder）に隔離する。
 */
type UpdatesResponse = { updates: UpdateStatusSummary };

const STATE_LABEL: Record<UpdateState, string> = {
  up_to_date: '最新',
  update_available: '更新あり',
  updating: '更新中',
  failed: '失敗',
};

const SCOPE_LABEL: Record<UpdateScope, string> = {
  platform: '全体',
  tenant: 'テナント',
  site: '拠点',
  device: '端末',
};

function scopeTarget(r: UpdateStatusRow): string {
  if (r.scope === 'platform') return '全体';
  return r.deviceId ?? r.siteId ?? r.tenantId ?? r.scope;
}

const COLUMNS: ReadonlyArray<Column<UpdateStatusRow>> = [
  { key: 'state', header: '状況', cell: (r) => STATE_LABEL[r.state] },
  { key: 'scope', header: '範囲', cell: (r) => SCOPE_LABEL[r.scope], cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'target', header: '対象', cell: (r) => scopeTarget(r), cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'component', header: 'コンポーネント', cell: (r) => r.component },
  {
    key: 'version',
    header: '現行→最新',
    cell: (r) => `${r.currentVersion}${r.currentVersion !== r.latestVersion ? ` → ${r.latestVersion}` : ''}`,
    cellStyle: () => ({ opacity: 0.8 }),
  },
  { key: 'checkedAt', header: '確認日時', cell: (r) => r.checkedAt, cellStyle: () => ({ opacity: 0.7 }) },
];

export function UpdateStatus() {
  const [data, setData] = useState<UpdatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/updates');
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'アップデート状況の取得に失敗しました。');
          return;
        }
        setData((await res.json()) as UpdatesResponse);
      } catch {
        // ネットワーク断・レスポンス解析失敗を握り潰さずエラー表示する。
        if (!cancelled) setError('アップデート状況の取得に失敗しました。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = data?.updates.updates ?? [];

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>アップデート状況</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        テナント / 拠点 / 端末単位のアップデート状況を横断確認します（読み取り中心）。対象テナント選択中は
        全体影響＋当該テナントに絞り込まれます。更新の実行・ロールバックは影響範囲が広いため、確認・
        昇格・監査を伴う導線に隔離します。
      </p>

      {error ? <p role="alert" style={{ color: 'var(--color-platform-warn)' }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard label="要対応（更新待ち/中/失敗）" value={data ? data.updates.pendingCount : '—'} />
        <MetricCard label="更新失敗" value={data ? data.updates.byState.failed : '—'} />
        <MetricCard label="更新あり" value={data ? data.updates.byState.update_available : '—'} />
        <MetricCard label="全対象" value={data ? data.updates.totalCount : '—'} />
      </div>

      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。読み込み中 / 失敗 / 0 件の
        出し分けは手書きの分岐ではなく `loaded` / `failed` で `DataTable` に委ねる
        （#947 で `<tbody>` 側に置いていたのと同じ `resolveAdminReadState` を通る）。
      */}
      <DataTable
        testId="platform-updates"
        scrollRegionLabel="アップデート状況"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        rowProps={(r) => ({ style: { opacity: r.pending ? 1 : 0.6 } })}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="アップデート状況の登録はありません。"
        failureMessage="アップデート状況を読み込めませんでした。"
      />

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="アップデート実行 / ロールバック" />
      </div>
    </section>
  );
}
