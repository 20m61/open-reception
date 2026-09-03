'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /*
   * 🔴 **操作の失敗を読み取りの `error` に載せない (#968 AC4)。**
   *
   * `error` は `DataTable` の `failed` を決めている。停止/有効化に失敗しただけで
   * サイト一覧が「読み込めませんでした。」へ落ちるのは、読めているのに読めていないと
   * 言うことになる。操作の失敗は操作の近くに、別の state で出す。
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** いま画面が指しているテナント。遷移をまたいだ古い応答を捨てるために持つ。 */
  const latestTenantId = useRef(tenantId);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}`);
      /*
       * 🔴 **成功枝にも世代ガードを掛ける (#968 レビュー 残存リスク 2)。**
       * catch 側だけを守っても、A の応答が**成功して**後着すれば B の画面に A の
       * `name` / 状態バッジ / サイト表が載る。しかも危険な操作のボタンのラベルは
       * `data.status` から決まるので、**B の画面で A の状態に応じたボタン**が出る。
       * `runLifecycle` が成功時に `load()` を呼ぶぶん、この窓は広がっている。
       */
      if (latestTenantId.current !== tenantId) return;
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
      /*
       * 🔴 **古い要求の失敗を新しい画面へ出さない (#896 レビュー m4)。**
       * `load` は `tenantId` ごとに作り直されるので、A から B へ遷移した直後に
       * **A の fetch が reject する**ことがある。素で `setError` すると B の画面に
       * 「テナント詳細の取得に失敗しました。」が出て、B の表が失敗側へ落ちる ——
       * B の取得はまだ成功する途中かもしれない。いま見ているテナント宛の失敗だけ出す。
       */
      if (latestTenantId.current === tenantId) setError('テナント詳細の取得に失敗しました。');
    }
  }, [tenantId]);

  useEffect(() => {
    latestTenantId.current = tenantId;
    /*
     * 🔴 **操作の失敗表示を遷移で捨てる (#968 レビュー B1)。**
     * 分離前は同じ文言が `error` に載っており、遷移後の `load()` 成功が
     * `setError(null)` で**必ず消していた**。AC4 のために state を分けた結果、
     * その消去経路が落ちる —— A の停止失敗が B の画面に出続ける。
     */
    setActionError(null);
    void load();
  }, [load, tenantId]);

  const runLifecycle = useCallback(
    async (action: TenantLifecycleAction, reason?: string) => {
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/platform/tenants/${encodeURIComponent(tenantId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, reason }),
        });
        /*
         * 🔴 **操作の失敗も「いま見ているテナント宛」だけ出す (#968 レビュー B1)。**
         * `load` の catch に付けたガードと同じ理由。PATCH の応答は遷移をまたいで
         * 後着しうるので、素で報告すると **B の停止ボタンの真上に A の失敗**が出る。
         * 「成功したか分からない」より悪い、**誤ったテナントへの帰属**になる。
         */
        if (latestTenantId.current !== tenantId) return;
        if (res.ok) await load();
        else setActionError('操作に失敗しました。');
      /*
       * 🔴 **破壊的操作を無言で失敗させない (#968 AC1)。** `try`/`finally` だけだと
       * `fetch` の reject（オフライン・DNS 断・接続断）は `void` に捨てられ、`busy` が
       * 戻るだけで画面には何も出ない。押した運用者は「何も起きなかった」と読み、
       * もう一度押すか、停止できたと誤解する ——「成功したかどうか分からない」を
       * 残さないことが、テナントの停止/有効化では最も重い。
       */
      } catch {
        if (latestTenantId.current === tenantId)
          setActionError('操作を送信できませんでした。通信を確認して、もう一度お試しください。');
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

      {error ? (
        <p role="alert" data-testid="platform-tenant-detail-error" style={{ color: 'var(--color-platform-warn)' }}>
          {error}
        </p>
      ) : null}

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
          {/* 操作の失敗はボタンの隣に出す（読み取りの失敗と混ぜない・#968 AC4）。 */}
          {actionError ? (
            <p role="alert" data-testid="platform-tenant-action-error" style={{ color: 'var(--color-platform-warn)' }}>
              {actionError}
            </p>
          ) : null}
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
