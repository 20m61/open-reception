'use client';

import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import type { SiteStatus } from '@/domain/tenant/types';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import { Button, DataTable, Field, Form, SaveFeedback, useSaveFeedback, type Column } from '@/components/admin/ui';
import { color, font, space } from '@/components/admin/ui/tokens';
import { useQueryParams } from './use-query-params';
import { useSiteList } from './use-site-list';
import { paginate, sortRows } from './list-io';
import { useTableSort } from './use-table-sort';
import { filterSites, sitesToCsv, type SiteListFilter } from './sites-filter';
import { resolveSiteListFeedback } from './site-list-feedback';
import { siteStatusState } from './state-vocabulary';

/**
 * 拠点管理 (issue #87, increment 1; 検索/フィルタ/ページング/CSV は #330 item2 残増分)。
 *
 * テナント配下の拠点一覧・作成・編集（名称）・有効/停止を管理 API 経由で行う。
 * Tenant > Site > Device の階層が分かるよう、各拠点に紐づく端末数・オンライン端末数を表示する
 * （Device の作り替えは行わず紐づけ表示に留める＝既存 kiosks 管理と二重管理しない）。
 *
 * 検索/フィルタ/ページ状態は監査ログ・受付履歴と同じく URL クエリを真実源にする（issue #94）。
 *
 * 現状の actor 解決は developer 相当（#80 写像が未配線）。複数テナント所属時の
 * Tenant 切り替え UI は次増分（docs/site-device-management-design.md §次増分）。
 * inc1 は単一テナント運用の互換シード `internal` を既定テナントとして扱う。
 */
const PAGE_SIZE = 20;

export function SitesManager({ tenantId }: { tenantId: string }) {
  // 一覧の取得は共有フックへ寄せる (#423)。作成・更新後は `reload()` で取り直す。
  // **`status` を捨てない** — 捨てると 401/403/5xx やオフラインが「拠点が 1 つも無い」と
  // 同じ見た目になる (#554 M3)。
  const { sites: items, status: listStatus, reload: load } = useSiteList(tenantId);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // 既存の `feedback`（一覧取得の状態）と混ざらないよう別名で受ける。
  const {
    feedback: saveFeedback,
    success: saveSucceeded,
    failure: saveFailed,
    clear: clearSaveFeedback,
  } = useSaveFeedback();

  const { get, setMany } = useQueryParams();
  const { sort, setSort } = useTableSort();
  const keyword = get('q');
  const filterStatus = get('status');
  const pageParam = get('page');

  const add = useCallback(async () => {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    clearSaveFeedback();
    try {
      /*
        **結果を捨てない (#870 増分 02)。** `await fetch(...)` の戻りを見ずに `load()` すると、
        403 / 409 / 5xx でも入力欄が空になって一覧が元のまま返るだけになり、運用者には
        「登録した」ように見える。viewer ロールが拠点を作ったつもりで作れていない、が起こる。
      */
      const res = await fetch('/api/admin/sites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, name }),
      }).catch(() => null);
      if (!res?.ok) {
        saveFailed('拠点を追加できませんでした。');
        return;
      }
      setName('');
      await load();
      saveSucceeded('拠点を追加しました。');
    } finally {
      setBusy(false);
    }
  }, [name, busy, tenantId, load, clearSaveFeedback, saveSucceeded, saveFailed]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      clearSaveFeedback();
      const res = await fetch(`/api/admin/sites/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, ...body }),
      }).catch(() => null);
      if (!res?.ok) {
        // 失敗したら `load()` しない。取り直すと行が元の値へ戻り、**変更が無かったように
        // 見える**（何も起きなかったのか、失敗したのかが区別できない）。
        saveFailed('変更を保存できませんでした。');
        return;
      }
      await load();
      saveSucceeded('変更を保存しました。');
    },
    [tenantId, load, clearSaveFeedback, saveSucceeded, saveFailed],
  );

  const toggle = useCallback(
    (s: SiteWithDevices) => patch(s.id, { status: s.status === 'active' ? 'suspended' : 'active' }),
    [patch],
  );

  const saveName = useCallback(
    async (id: string) => {
      if (editName.trim() === '') return;
      await patch(id, { name: editName });
      setEditingId(null);
      setEditName('');
    },
    [editName, patch],
  );

  const columns = useMemo<Column<SiteWithDevices>[]>(
    () => [
      {
        key: 'name',
        header: '拠点名',
        sortValue: (s) => s.name,
        cellTestId: () => 'site-name',
        cell: (s) =>
          editingId === s.id ? (
            <input
              data-testid="site-edit-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={inputStyle}
            />
          ) : (
            // 名称から拠点詳細へ入る (#421)。詳細はこの拠点の設定への結節点。
            <Link href={`/admin/sites/${encodeURIComponent(s.id)}`} data-testid="site-detail-link">
              {s.name}
            </Link>
          ),
      },
      {
        key: 'devices',
        header: '端末',
        cellTestId: () => 'site-devices',
        // 表示は「n / m オンライン」だが、比較はオンライン台数の数値で行う。
        sortValue: (s) => s.onlineDeviceCount,
        cell: (s) => `${s.onlineDeviceCount} / ${s.deviceCount} オンライン`,
      },
      {
        key: 'status',
        header: '状態',
        cellStyle: (s) => ({ color: siteStatusState(s.status).color }),
        sortValue: (s) => siteStatusState(s.status).label,
        cell: (s) => siteStatusState(s.status).label,
      },
      {
        key: 'actions',
        header: '操作',
        cell: (s) => (
          <div style={{ display: 'flex', gap: 6 }}>
            {editingId === s.id ? (
              <>
                <Button data-testid="site-save" onClick={() => saveName(s.id)}>
                  保存
                </Button>
                <Button onClick={() => setEditingId(null)}>取消</Button>
              </>
            ) : (
              <>
                <Button
                  data-testid="site-edit"
                  onClick={() => {
                    setEditingId(s.id);
                    setEditName(s.name);
                  }}
                >
                  名称編集
                </Button>
                <Button data-testid="site-toggle" onClick={() => toggle(s)}>
                  {s.status === 'active' ? '停止' : '再開'}
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [editingId, editName, saveName, toggle],
  );

  const filter: SiteListFilter = useMemo(
    () => ({ keyword: keyword || undefined, status: (filterStatus as SiteStatus) || undefined }),
    [keyword, filterStatus],
  );
  const filtered = useMemo(() => filterSites(items, filter), [items, filter]);
  // 並べ替えてからページを切る（逆にすると 1 ページぶんだけが並び替わる）。
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const paged = useMemo(() => paginate(sorted, Number(pageParam) || 1, PAGE_SIZE), [sorted, pageParam]);
  const hasFilter = Boolean(keyword || filterStatus);
  const feedback = resolveSiteListFeedback(listStatus, hasFilter);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });

  const downloadCsv = () => {
    const csv = sitesToCsv(filtered);
    // Excel（Windows/日本語ロケール）で文字化けしないよう UTF-8 BOM を付与する。
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sites-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>拠点管理</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> 配下の受付拠点を管理します。各拠点に紐づく受付端末数を表示します。
      </p>

      <Form
        onSubmit={add}
        aria-label="拠点を追加"
        style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}
      >
        <Field label="拠点名" htmlFor="site-name-input">
          <input
            id="site-name-input"
            data-testid="site-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </Field>
        {/*
          **一覧の取得状態をここに混ぜない。** 読み（GET）の失敗で書き（作成）を殺すと、
          一覧が 1 回取れないだけで拠点を追加できなくなる（#552 で実際に P1 になった形）。
          作成の可否は入力と実行中かどうかだけで決める。
        */}
        <Button variant="primary" type="submit" data-testid="site-add" disabled={busy || name.trim() === ''}>
          追加
        </Button>
        <SaveFeedback feedback={saveFeedback} successTestId="site-saved" errorTestId="site-save-error" />
      </Form>

      <div
        data-testid="site-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end', marginBottom: space.md }}
      >
        <Field label="拠点名で検索" htmlFor="site-filter-keyword">
          <input
            id="site-filter-keyword"
            data-testid="site-filter-keyword"
            value={keyword}
            onChange={(e) => updateFilter({ q: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="状態で絞り込み" htmlFor="site-filter-status">
          <select
            id="site-filter-status"
            data-testid="site-filter-status"
            value={filterStatus}
            onChange={(e) => updateFilter({ status: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            <option value="active">{siteStatusState('active').label}</option>
            <option value="suspended">{siteStatusState('suspended').label}</option>
          </select>
        </Field>
        {hasFilter ? (
          <Button variant="secondary" onClick={() => setMany({ q: '', status: '', page: '', sort: '', sortDir: '' })} data-testid="site-filter-reset">
            条件をクリア
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          data-testid="site-csv-export"
        >
          CSV エクスポート
        </Button>
      </div>

      {feedback.showRetry ? (
        <div
          data-testid="site-list-error"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: space.sm,
            marginBottom: space.sm,
            color: color.danger,
            fontSize: font.small,
          }}
        >
          <span>拠点一覧を取得できませんでした。表示は最新ではありません。</span>
          <Button variant="secondary" onClick={() => void load()} data-testid="site-list-retry">
            再試行
          </Button>
        </div>
      ) : null}

      {feedback.showCount ? (
        <p data-testid="site-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0, marginBottom: space.sm }}>
          {items.length} 件中 {filtered.length} 件を表示
        </p>
      ) : null}

      <DataTable
        testId="site-table"
        columns={columns}
        rows={paged.items}
        rowKey={(s) => s.id}
        rowTestId={() => 'site-row'}
        sort={sort}
        onSortChange={setSort}
        emptyMessage={feedback.emptyMessage}
      />

      {paged.pageCount > 1 ? (
        <div
          data-testid="site-pagination"
          style={{ display: 'flex', gap: space.sm, alignItems: 'center', marginTop: space.sm }}
        >
          <Button
            variant="secondary"
            data-testid="site-page-prev"
            disabled={paged.page <= 1}
            onClick={() => setMany({ page: String(paged.page - 1) })}
          >
            前へ
          </Button>
          <span style={{ fontSize: font.small, opacity: 0.8 }} data-testid="site-page-label">
            {paged.page} / {paged.pageCount} ページ
          </span>
          <Button
            variant="secondary"
            data-testid="site-page-next"
            disabled={paged.page >= paged.pageCount}
            onClick={() => setMany({ page: String(paged.page + 1) })}
          >
            次へ
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const inputStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
