'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { VisitStay } from '@/domain/visit/types';
import {
  Button,
  CardGrid,
  DataTable,
  Field,
  MetricCard,
  Pager,
  Section,
  StatusBadge,
  type Column,
} from '@/components/admin/ui';
import { color, font, radius, space } from '@/components/admin/ui/tokens';
import { useQueryParams } from './use-query-params';
import { useTableSort } from './use-table-sort';
import { useSiteScope } from './use-site-scope';
import { SiteScopeSelect } from './SiteScopeSelect';
import { paginate, sortRows } from './list-io';
import { filterStays, staysToCsv, type StayListFilter } from './stay/list-filter';
import type { StayStatus } from '@/domain/visit/types';
import {
  availableActions,
  durationText,
  sortStays,
  statusKind,
  statusLabel,
  summarize,
} from './stay/logic';
import { resolveStayScopeActions } from './stay/scope-actions';

/**
 * 滞在状況 管理画面 (issue #102, increment 1; フィルタ/ページング/CSV は #330 item2 残増分)。
 *
 * inc1 の滞在 API（/api/admin/stay/**）を介して在館中 / 退館済み / 未退館を一覧表示し、
 * 在館者を退館済みにする（誤登録は取消）。
 *
 * 表示変換・集計・操作可否は副作用なしの純ロジック（./stay/logic.ts）へ委譲する。
 * VisitStay に PII は無く、来訪者識別は参照（受付番号 = id / receptionId）のみ。CSV にも
 * PII は含まれない（`stay/list-filter.ts` 参照）。
 *
 * 検索/フィルタ/ページ状態は監査ログ・受付履歴と同じく URL クエリを真実源にする（issue #94）。
 *
 * **対象拠点は URL が真実源** (#554)。以前は component state ＋自由入力で、しかも既定が
 * `'default'`（実在する既定拠点は `'default-site'`）だったため、**画面を開いただけで
 * 実在しない拠点を読んでいた** — 在館者は端末の実拠点で記録されるので一覧は空になり、
 * それは「誰も建物に居ない」と読める。テナントも `'internal'` 固定だったので、テナントを
 * 切り替えても在館状況は前テナントのままだった。どちらもサーバ解決の値を props で受け取る。
 */
const PAGE_SIZE = 20;

export function StayManager({
  tenantId,
  siteId: defaultSiteId,
}: {
  tenantId: string;
  /** サーバが解決した既定拠点（`resolveDefaultScope().siteId`）。ヘッダの対象拠点と同じ出所。 */
  siteId: string;
}) {
  const { sites, siteId, scopeKey, scopeReady, isCurrentScope, selectSite, sitePending, listStatus, reloadSites } =
    useSiteScope(tenantId, defaultSiteId);
  const [items, setItems] = useState<VisitStay[]>([]);
  /**
   * **どのスコープの滞在が今画面に載っているか。**
   *
   * `isCurrentScope` は「古い応答を反映しない」だけで、**既に描かれている前拠点の行は
   * そのまま残る**。退館・取消は滞在 ID でしか対象を決めないので、見出しとセレクタが B を
   * 指したまま A の来訪者を退館させられてしまう（#539 / #541 と同型）。
   * 拠点だけで識別すると**同じ拠点 ID を持つ別テナント**で守れないので `scopeKey` で持つ。
   */
  const [staysScopeKey, setStaysScopeKey] = useState<string | null>(null);
  const dataLoaded = staysScopeKey === scopeKey;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * **取得の失敗だけ**を別に持つ。`error` は操作（退館・取消）の失敗にも使うので、
   * これを兼ねると「退館に失敗した」状態で空一覧の理由が「取得できませんでした」に
   * すり替わる。理由の表示は原因ごとに分ける。
   */
  const [loadFailed, setLoadFailed] = useState(false);
  // 滞在時間表示の基準。マウント時刻で固定し、再レンダの揺れを抑える。
  const [now] = useState(() => new Date());

  /**
   * 可否と断定の判断はここ 1 箇所。**ハンドラも、ボタンの `disabled` も、集計の表示も
   * すべてこの値を見る**（分岐しようがなくする。#556 で同じ型の P1 を出している）。
   */
  const actions = resolveStayScopeActions({
    scopeReady,
    dataLoaded,
    sitePending,
    busy,
    listStatus,
    loadFailed,
    hasSites: sites.length > 0,
  });

  const { get, setMany } = useQueryParams();
  const { sort, setSort } = useTableSort();
  const filterStart = get('start');
  const filterEnd = get('end');
  const filterStatus = get('status');
  const pageParam = get('page');

  const load = useCallback(async () => {
    // 拠点が確定するまで取得しない（既定拠点と URL 指定で 2 本飛ばさない）。
    if (!scopeReady) return;
    const startedWith = scopeKey;
    setError(null);
    let res: Response;
    try {
      res = await fetch(
        `/api/admin/stay?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
      );
    } catch {
      // オフライン等。**握り潰すと「読み込み中…」のまま**になる（失敗にすら落ちない）。
      if (!isCurrentScope(startedWith)) return;
      setLoadFailed(true);
      setError('滞在状況の取得に失敗しました。');
      return;
    }
    // 取得中に拠点／テナントが変わっていたら捨てる。
    if (!isCurrentScope(startedWith)) return;
    if (res.ok) {
      setLoadFailed(false);
      setStaysScopeKey(startedWith);
      setItems((await res.json()) as VisitStay[]);
    } else {
      setLoadFailed(true);
      setError('滞在状況の取得に失敗しました。');
    }
  }, [tenantId, siteId, scopeKey, scopeReady, isCurrentScope]);

  useEffect(() => {
    // 拠点が変わった瞬間に前拠点の行を捨てる。届くまでの間、古い行を触らせない。
    setStaysScopeKey((prev) => (prev === scopeKey ? prev : null));
    // 前拠点の失敗を新しい拠点へ持ち越さない（切替直後に「取得できませんでした」と出る）。
    setLoadFailed(false);
    setItems((prev) => (prev.length === 0 ? prev : []));
    void load();
  }, [load, scopeKey]);

  const act = useCallback(
    async (path: string) => {
      // ボタンと同じ 1 つの値を見る（`actions.canMutate`）。押せてしまった場合の保険。
      if (!actions.canMutate) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, siteId }),
        });
        if (!res.ok) setError('操作に失敗しました。');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [tenantId, siteId, load, actions.canMutate],
  );

  const checkout = useCallback((s: VisitStay) => act(`/api/admin/stay/${s.id}/checkout`), [act]);
  const cancel = useCallback((s: VisitStay) => act(`/api/admin/stay/${s.id}/cancel`), [act]);

  const summary = useMemo(() => summarize(items, now), [items, now]);
  const sorted = useMemo(() => sortStays(items), [items]);

  const filter: StayListFilter = useMemo(
    () => ({
      start: filterStart || undefined,
      end: filterEnd || undefined,
      status: (filterStatus as StayStatus) || undefined,
    }),
    [filterStart, filterEnd, filterStatus],
  );
  const filtered = useMemo(() => filterStays(sorted, filter), [sorted, filter]);
  const hasFilter = Boolean(filterStart || filterEnd || filterStatus);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });
  const resetFilter = () => setMany({ start: '', end: '', status: '', page: '' });

  const downloadCsv = () => {
    const csv = staysToCsv(filtered, now);
    // Excel（Windows/日本語ロケール）で文字化けしないよう UTF-8 BOM を付与する。
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stays-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo<ReadonlyArray<Column<VisitStay>>>(
    () => (
[
    {
      key: 'id',
      sortValue: (s) => s.id,
      header: '受付番号',
      cell: (s) => <code style={{ fontSize: '0.8rem' }}>{s.id}</code>,
    },
    { key: 'checkedInAt', header: '入館', cell: (s) => formatDateTime(s.checkedInAt) },
    {
      key: 'checkedOutAt',
      header: '退館',
      cell: (s) => (s.checkedOutAt ? formatDateTime(s.checkedOutAt) : '—'),
    },
    { key: 'duration', header: '滞在時間', cell: (s) => durationText(s, now) },
    {
      key: 'status',
      header: '状態',
      cell: (s) => <StatusBadge status={statusKind(s.status)} label={statusLabel(s.status)} />,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (s) => (
        <RowActions stay={s} onCheckout={checkout} onCancel={cancel} canMutate={actions.canMutate} />
      ),
    },
  ]
    ),
    [actions.canMutate, cancel, checkout, now],
  );

  /*
   * `sorted` は既に業務上の既定順（`sortStays`）で使われているので、利用者の
   * 並べ替えは**フィルタ後**に別名で重ねる。解除すると既定の順序へ戻る。
   */
  const userSorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const paged = useMemo(() => paginate(userSorted, Number(pageParam) || 1, PAGE_SIZE), [userSorted, pageParam]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
      <div>
        <h1 style={{ marginTop: 0, marginBottom: space.xs }}>在館状況</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>
          テナント <code>{tenantId}</code> 配下の来訪者の在館 / 退館を確認します。滞在情報には個人情報を
          保存せず、来訪者の識別は受付番号・受付セッション参照のみで行います。
        </p>
      </div>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <SiteScopeSelect
          sites={sites}
          siteId={siteId}
          onSelect={selectSite}
          onRetry={reloadSites}
          disabled={sitePending || busy}
          testId="stay-site-select"
          status={listStatus}
        />
        <Button data-testid="stay-refresh" onClick={() => void load()} disabled={!actions.canRefresh}>
          更新
        </Button>
      </div>

      <Section title="状況" description="現在の滞在を状態別に集計しています。">
        {/*
          **「まだ分かっていない」を「0 人」として出さない。** 空の在館者一覧は
          「誰も建物に居ない」と読めるので、拠点切替中や取得失敗時に 0 を出すと
          避難確認のような場面で嘘をつく。
        */}
        {actions.showSummary ? (
          <CardGrid minWidth={150}>
            <MetricCard label="合計" value={summary.total} />
            <MetricCard label="在館中" value={summary.present} tone="success" />
            <MetricCard label="未退館" value={summary.overstay} tone="warning" />
            <MetricCard label="退館済み" value={summary.checkedOut} tone="accent" />
            <MetricCard label="取消" value={summary.cancelled} />
          </CardGrid>
        ) : (
          <p data-testid="stay-summary-unavailable" style={{ opacity: 0.7, margin: 0 }}>
            {actions.emptyMessage}
          </p>
        )}
      </Section>

      {error ? (
        <div data-testid="stay-error" role="alert" style={{ color: color.danger, fontSize: '0.9rem' }}>
          {error}
        </div>
      ) : null}

      <Section title="滞在一覧" description="在館中を先頭に、入館の新しい順で表示します。">
        <div
          data-testid="stay-filters"
          style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end', marginBottom: space.md }}
        >
          <Field label="入館日（開始）" htmlFor="stay-filter-start">
            <input
              id="stay-filter-start"
              type="date"
              data-testid="stay-filter-start"
              value={filterStart}
              onChange={(e) => updateFilter({ start: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="入館日（終了）" htmlFor="stay-filter-end">
            <input
              id="stay-filter-end"
              type="date"
              data-testid="stay-filter-end"
              value={filterEnd}
              onChange={(e) => updateFilter({ end: e.target.value })}
              style={inputStyle}
            />
          </Field>
          <Field label="状態" htmlFor="stay-filter-status">
            <select
              id="stay-filter-status"
              data-testid="stay-filter-status"
              value={filterStatus}
              onChange={(e) => updateFilter({ status: e.target.value })}
              style={inputStyle}
            >
              <option value="">すべて</option>
              <option value="present">在館中</option>
              <option value="checked_out">退館済み</option>
              <option value="cancelled">取消</option>
            </select>
          </Field>
          {hasFilter ? (
            <Button variant="secondary" onClick={resetFilter} data-testid="stay-filter-reset">
              条件をクリア
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={downloadCsv}
            disabled={filtered.length === 0}
            data-testid="stay-csv-export"
          >
            CSV エクスポート
          </Button>
        </div>

        {actions.showSummary ? (
          <p data-testid="stay-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0, marginBottom: space.sm }}>
            {sorted.length} 件中 {filtered.length} 件を表示
          </p>
        ) : null}

        <DataTable
          columns={columns}
          rows={paged.items}
          rowKey={(s) => s.id}
          sort={sort}
          onSortChange={setSort}
          emptyMessage={
            // 取得できていない間は「まだありません」と断定しない（同上の理由）。
            !actions.showSummary
              ? actions.emptyMessage
              : hasFilter
                ? '条件に一致する滞在記録はありません。'
                : 'この拠点の滞在記録はまだありません。'
          }
          testId="stay-table"
        />

        <Pager
          page={paged.page}
          pageCount={paged.pageCount}
          onChange={(next) => setMany({ page: String(next) })}
          testIdPrefix="stay"
        />
      </Section>
    </div>
  );
}

function RowActions({
  stay,
  onCheckout,
  onCancel,
  canMutate,
}: {
  stay: VisitStay;
  onCheckout: (s: VisitStay) => void;
  onCancel: (s: VisitStay) => void;
  /**
   * ハンドラ側（`act`）が見ているのと**同じ値**。別々に判断すると、押せるのに何も
   * 起きない（サイレント no-op）か、止めたはずの操作が通るかのどちらかになる。
   */
  canMutate: boolean;
}) {
  const actions = availableActions(stay.status);
  if (!actions.canCheckout && !actions.canCancel) return <span style={{ opacity: 0.5 }}>—</span>;
  return (
    <div style={{ display: 'inline-flex', gap: space.xs, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {actions.canCheckout ? (
        <Button variant="primary" data-testid="stay-checkout" onClick={() => onCheckout(stay)} disabled={!canMutate}>
          退館
        </Button>
      ) : null}
      {actions.canCancel ? (
        <Button variant="danger" data-testid="stay-cancel" onClick={() => onCancel(stay)} disabled={!canMutate}>
          取消
        </Button>
      ) : null}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
}

const inputStyle: React.CSSProperties = {
  minHeight: 38,
  padding: '8px 12px',
  borderRadius: radius.sm,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  minWidth: 200,
};
