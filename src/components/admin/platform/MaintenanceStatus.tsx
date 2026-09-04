'use client';

import { useEffect, useState } from 'react';
import type { MaintenanceSummary } from '@/domain/platform/console-summary';
import type { IncidentRow, IncidentSeverity, IncidentSummary } from '@/domain/platform/incident';
import type {
  MaintenanceImpact,
  MaintenanceWindowRow,
  MaintenanceWindowStatus,
  MaintenanceWindowSummary,
} from '@/domain/platform/maintenance-window';
import type { NoticeLevel, NoticeRow, NoticeSummary } from '@/domain/platform/notice';
import { NoticePublishForm } from './NoticePublishForm';
import { DangerActionPlaceholder } from './primitives';
import { DataTable, MetricCard, type Column } from '@/components/admin/ui';
import { PLATFORM_READ_TIMEOUT_MS, isMaintenanceShape, readTimeoutMessage } from './read-response';

/**
 * メンテナンス状況・障害情報（read 中心） (issue #90, increment 2/3e)。
 *
 * /api/platform/maintenance（developer 専用 read）から、メンテナンス表示中の端末・障害・
 * 予定メンテナンス・お知らせを横断確認する。機密値・PII・操作者識別子は含めない。
 * 破壊的操作のうち**お知らせ登録**は JIT 昇格つきフォーム（NoticePublishForm, #83 inc4d）へ
 * 格上げ済み。メンテナンス発動・障害登録は引き続き DangerActionPlaceholder に隔離する。
 */
type MaintenanceResponse = {
  summary: MaintenanceSummary;
  incidents: IncidentSummary;
  windows: MaintenanceWindowSummary;
  notices: NoticeSummary;
};

const NOTICE_LEVEL_LABEL: Record<NoticeLevel, string> = {
  info: 'お知らせ',
  warning: '注意',
  critical: '重要',
};

const NOTICE_STATUS_LABEL: Record<NoticeRow['status'], string> = {
  published: '掲示中',
  archived: '終了',
};

function noticeScopeLabel(n: NoticeRow): string {
  if (n.scope === 'platform') return '全体';
  return n.deviceId ?? n.siteId ?? n.tenantId ?? n.scope;
}

const WINDOW_STATUS_LABEL: Record<MaintenanceWindowStatus, string> = {
  scheduled: '予定',
  active: '進行中',
  completed: '完了',
  cancelled: '取消',
};

const IMPACT_LABEL: Record<MaintenanceImpact, string> = {
  notice_only: '案内のみ',
  limited: '一部制限',
  read_only: '読み取り専用',
  unavailable: '利用不可',
};

function windowScopeLabel(w: MaintenanceWindowRow): string {
  if (w.scope === 'platform') return '全体';
  return w.deviceId ?? w.siteId ?? w.tenantId ?? w.scope;
}

const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  info: '情報',
  minor: '軽微',
  major: '重大',
  critical: '致命的',
};

const STATUS_LABEL: Record<IncidentRow['status'], string> = {
  investigating: '調査中',
  identified: '原因特定',
  monitoring: '経過観察',
  resolved: '復旧済',
};

function incidentScopeLabel(i: IncidentRow): string {
  if (i.scope === 'platform') return '全体';
  return i.deviceId ?? i.siteId ?? i.tenantId ?? i.scope;
}

const DEVICE_COLUMNS: ReadonlyArray<Column<MaintenanceSummary['devices'][number]>> = [
  { key: 'tenant', header: 'テナント', cell: (d) => d.tenantName },
  { key: 'device', header: '端末', cell: (d) => d.deviceName },
  { key: 'site', header: 'サイト', cell: (d) => d.siteId, cellStyle: () => ({ opacity: 0.7 }) },
];

const INCIDENT_COLUMNS: ReadonlyArray<Column<IncidentRow>> = [
  { key: 'severity', header: '重大度', cell: (i) => SEVERITY_LABEL[i.severity] },
  { key: 'status', header: '状態', cell: (i) => STATUS_LABEL[i.status], cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'scope', header: '範囲', cell: (i) => incidentScopeLabel(i), cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'title', header: '概要', cell: (i) => i.title },
  { key: 'startedAt', header: '発生', cell: (i) => i.startedAt, cellStyle: () => ({ opacity: 0.7 }) },
];

const WINDOW_COLUMNS: ReadonlyArray<Column<MaintenanceWindowRow>> = [
  { key: 'status', header: '状態', cell: (w) => WINDOW_STATUS_LABEL[w.status] },
  { key: 'scope', header: '範囲', cell: (w) => windowScopeLabel(w), cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'impact', header: '影響', cell: (w) => IMPACT_LABEL[w.impact], cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'message', header: '概要', cell: (w) => w.message },
  { key: 'startsAt', header: '開始', cell: (w) => w.startsAt, cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'endsAt', header: '終了', cell: (w) => w.endsAt, cellStyle: () => ({ opacity: 0.7 }) },
];

const NOTICE_COLUMNS: ReadonlyArray<Column<NoticeRow>> = [
  { key: 'level', header: '重要度', cell: (n) => NOTICE_LEVEL_LABEL[n.level] },
  { key: 'status', header: '状態', cell: (n) => NOTICE_STATUS_LABEL[n.status], cellStyle: () => ({ opacity: 0.8 }) },
  { key: 'scope', header: '範囲', cell: (n) => noticeScopeLabel(n), cellStyle: () => ({ opacity: 0.7 }) },
  { key: 'title', header: '件名', cell: (n) => n.title },
  { key: 'publishedAt', header: '公開', cell: (n) => n.publishedAt, cellStyle: () => ({ opacity: 0.7 }) },
];

export function MaintenanceStatus() {
  const [data, setData] = useState<MaintenanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // お知らせ登録（NoticePublishForm）成功後に refreshKey を進めて再取得し、一覧へ即時反映する。
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/maintenance', {
          signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(res.status === 403 ? 'この画面の閲覧権限がありません。' : 'メンテナンス状況の取得に失敗しました。');
          return;
        }
        const body: unknown = await res.json();
        /*
         * 形が違う 200 は「0 件」ではなく「読めなかった」(#973 AC7)。
         * 「進行中の障害」カードは `windows.scheduledCount + activeCount` を足すので、
         * 片方が欠けると **`NaN` が出る**。0 件と読ませると「障害は起きていない」と
         * 誤読されるので、断定せず失敗として出す。
         */
        if (!isMaintenanceShape(body)) {
          setError('メンテナンス状況の形式が不正です。時間をおいて再試行してください。');
          return;
        }
        setError(null);
        setData(body as MaintenanceResponse);
      /*
       * 🔴 **通信そのものが失敗した場合も「失敗」へ落とす (#896 レビュー M3)。**
       * `fetch` の reject（オフライン・DNS・接続断）や、HTML が返って `res.json()` が
       * 投げるケースを拾わないと `data` も `error` も `null` のままになり、
       * `resolveAdminReadState` は `'loading'` を返す ——「失敗が永遠の読み込み中に
       * 化ける」まさにその形で、画面には再試行の導線も `role="alert"` も出ない。
       */
      } catch (cause) {
        /*
         * 🔴 **ガードは `if (!cancelled) setError(...)` の形のまま置く。** 早期 return へ
         * 崩すと `tests/config/platform-list-states.test.ts` の「古い応答を捨てるガード」
         * 検査から外れる —— 方式を替えると、前の方式が守っていた変異が黙って落ちる
         * (`.claude/rules/opus5-autonomous-loop.md`)。返ってこない読み取りも
         * 「終わらない待ち」にしない (#973)。
         */
        if (!cancelled)
          setError(
            cause instanceof Error && cause.name === 'TimeoutError'
              ? readTimeoutMessage('メンテナンス状況')
              : 'メンテナンス状況の取得に失敗しました。',
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>メンテナンス</h1>
      <p style={{ opacity: 0.85, maxWidth: 760 }}>
        メンテナンス表示中の端末・障害・予定メンテナンス・お知らせを横断確認します（読み取り中心）。
        対象テナント選択中は全体影響＋当該テナントに絞り込まれます。状態の変更・登録は影響範囲が
        広いため、確認・昇格・監査を伴う導線に隔離します。
      </p>

      {error ? (
        <p role="alert" data-testid="platform-maintenance-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', marginBottom: 'var(--space-md)' }}>
        <MetricCard
          label="メンテナンス表示中の端末"
          value={data ? data.summary.devicesInMaintenance : '—'}
        />
        <MetricCard label="進行中の障害" value={data ? data.incidents.activeCount : '—'} />
        <MetricCard
          label="メンテナンス予定/進行"
          value={data ? data.windows.scheduledCount + data.windows.activeCount : '—'}
        />
        <MetricCard label="掲示中のお知らせ" value={data ? data.notices.activeCount : '—'} />
      </div>

      <h2 style={{ fontSize: '1rem', opacity: 0.7 }}>メンテナンス表示中の端末</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。横スクロール領域は
        `DataTable` が持つので、外側の `overflowX` ラッパは要らない。3 状態は
        `loaded` / `failed` で渡す（#947 で生 `<tbody>` に置いていた 3 状態の判断を、部品側へ移したもの）。
      */}
      <DataTable
        testId="platform-maintenance-devices"
        scrollRegionLabel="メンテナンス表示中の端末"
        columns={DEVICE_COLUMNS}
        rows={data?.summary.devices ?? []}
        rowKey={(d) => d.deviceId}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="端末がありません。"
        failureMessage="メンテナンス表示中の端末を読み込めませんでした。"
      />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>障害・インシデント</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。あわせて「まだ読めていない」を
        0 件と混ぜないようにした（移行前は `data && …length === 0` の分岐だったため、
        読み込み中・失敗のときは**見出しの下に空の表だけ**が出ていた）。
      */}
      <DataTable
        testId="platform-incidents"
        scrollRegionLabel="障害・インシデント"
        columns={INCIDENT_COLUMNS}
        rows={data?.incidents.incidents ?? []}
        rowKey={(i) => i.id}
        rowProps={(i) => ({ style: { opacity: i.active ? 1 : 0.55 } })}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="登録された障害情報はありません。"
        failureMessage="障害情報を読み込めませんでした。"
      />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>予定メンテナンス</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。あわせて「まだ読めていない」を
        0 件と混ぜないようにした（移行前は `data && …length === 0` の分岐だったため、
        読み込み中・失敗のときは**見出しの下に空の表だけ**が出ていた）。
      */}
      <DataTable
        testId="platform-maintenance-windows"
        scrollRegionLabel="予定メンテナンス"
        columns={WINDOW_COLUMNS}
        rows={data?.windows.windows ?? []}
        rowKey={(w) => w.id}
        rowProps={(w) => ({ style: { opacity: w.open ? 1 : 0.55 } })}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="予定メンテナンスはありません。"
        failureMessage="予定メンテナンスを読み込めませんでした。"
      />

      <h2 style={{ fontSize: '1rem', opacity: 0.7, marginTop: 'var(--space-lg)' }}>お知らせ</h2>
      {/*
        生 `<table>` を共有 `ui/DataTable` へ寄せた (#896 AC1)。あわせて「まだ読めていない」を
        0 件と混ぜないようにした（移行前は `data && …length === 0` の分岐だったため、
        読み込み中・失敗のときは**見出しの下に空の表だけ**が出ていた）。
      */}
      <DataTable
        testId="platform-notices"
        scrollRegionLabel="お知らせ"
        columns={NOTICE_COLUMNS}
        rows={data?.notices.notices ?? []}
        rowKey={(n) => n.id}
        rowProps={(n) => ({ style: { opacity: n.active ? 1 : 0.55 } })}
        loaded={data !== null}
        failed={error !== null}
        emptyMessage="お知らせはありません。"
        failureMessage="お知らせを読み込めませんでした。"
      />

      <div style={{ marginTop: 'var(--space-lg)', maxWidth: 760, display: 'grid', gap: 'var(--space-md)' }}>
        <NoticePublishForm onPublished={() => setRefreshKey((k) => k + 1)} />
        <DangerActionPlaceholder label="メンテナンスモード発動 / 障害情報の登録" />
      </div>
    </section>
  );
}
