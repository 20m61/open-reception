'use client';

import { useCallback, useMemo } from 'react';
import type { AuditAction, AuditLog } from '@/domain/reception/log';
import { filterAuditLogs, type AuditFilter } from '@/domain/audit/audit-filter';
import { Button, DataTable, Field, color, font, radius, space, type Column } from '@/components/admin/ui';
import { useQueryParams } from '@/components/admin/use-query-params';
import { paginate, sortRows } from '@/components/admin/list-io';
import { useTableSort } from '@/components/admin/use-table-sort';
import { auditLogsToCsv } from './logic';

const PAGE_SIZE = 20;

/**
 * 監査ログの検索・フィルタ・ページング・CSV エクスポート (issue #89, increment 2 / #905)。
 *
 * read 専用。サーバから渡された監査ログ（PII を含まない）をクライアント側で
 * 期間・アクション種別・主体・キーワードでフィルタする。絞り込みロジックは
 * 純関数 filterAuditLogs に委譲し、本コンポーネントは入力 UI と描画のみを担う。
 *
 * 監査アクションは新規追加しない。表示ラベルは呼び出し側が渡す非網羅マップ
 * （未登録は raw 文字列フォールバック）を使う。
 *
 * 🔴 **兄弟の `receptions/ReceptionsViewer` と同じ形にする (#905 / 課題 17)。**
 * `app/admin/receptions/page.tsx` は「監査ログと同じ設計」と書いていたが、実際には
 * こちらが遅れており、生 `<table>` に**絞り込み後の全件を描いていた**。
 * 共有ユーティリティ（`list-io.ts` の `paginate` / `csvCell` / `toCsv`）は既にあった。
 */
export type ActionFacet = { action: string; count: number };

export function AuditLogViewer({
  logs,
  actionFacets,
  actionLabels,
}: {
  logs: readonly AuditLog[];
  actionFacets: readonly ActionFacet[];
  actionLabels: Readonly<Partial<Record<AuditAction, string>>>;
}) {
  // 検索/フィルタ状態は URL クエリを真実源にする (issue #94)。戻る/進む・リロード・共有で復元される。
  const { get, setMany } = useQueryParams();
  const start = get('start');
  const end = get('end');
  const action = get('action');
  const actor = get('actor');
  const keyword = get('keyword');
  const pageParam = get('page');

  const filter: AuditFilter = useMemo(
    () => ({
      start: start || undefined,
      end: end || undefined,
      actions: action ? [action] : undefined,
      actor: actor || undefined,
      keyword: keyword || undefined,
    }),
    [start, end, action, actor, keyword],
  );

  const filtered = useMemo(() => filterAuditLogs(logs, filter), [logs, filter]);
  const { sort, setSort } = useTableSort();
  const labelFor = useCallback(
    (a: string) => actionLabels[a as AuditAction] ?? a,
    [actionLabels],
  );
  const hasFilter = Boolean(start || end || action || actor || keyword);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });
  const reset = () =>
    setMany({ start: '', end: '', action: '', actor: '', keyword: '', page: '', sort: '', sortDir: '' });

  const downloadCsv = () => {
    const csv = auditLogsToCsv(filtered, labelFor);
    // Excel（Windows/日本語ロケール）で文字化けしないよう UTF-8 BOM を付与する。
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo<Column<AuditLog>[]>(
    () => [
      {
        key: 'at',
        header: '日時',
        cell: (l) => new Date(l.at).toLocaleString('ja-JP'),
        sortValue: (l) => l.at,
      },
      { key: 'action', header: '操作', cell: (l) => labelFor(l.action), sortValue: (l) => labelFor(l.action) },
      { key: 'actor', header: '主体', cell: (l) => l.actor, sortValue: (l) => l.actor },
      {
        key: 'target',
        header: '対象',
        cell: (l) => (
          <>
            {l.targetType ?? '-'}
            {l.targetId ? <span style={{ opacity: 0.6 }}> {l.targetId}</span> : null}
          </>
        ),
      },
    ],
    [labelFor],
  );

  /*
   * 🔴 **並べ替えてからページを切る。** 逆にすると「並べ替えたのに 2 ページ目に
   * 小さい値が残っている」という壊れ方になる（ページを切ったあとの 20 件だけが
   * 並び替わる）。
   */
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const paged = useMemo(
    () => paginate(sorted, Number(pageParam) || 1, PAGE_SIZE),
    [sorted, pageParam],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      <div
        data-testid="audit-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }}
      >
        <Field label="開始日" htmlFor="audit-filter-start">
          <input
            id="audit-filter-start"
            type="date"
            data-testid="audit-filter-start"
            value={start}
            onChange={(e) => updateFilter({ start: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="終了日" htmlFor="audit-filter-end">
          <input
            id="audit-filter-end"
            type="date"
            data-testid="audit-filter-end"
            value={end}
            onChange={(e) => updateFilter({ end: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="操作種別" htmlFor="audit-filter-action">
          <select
            id="audit-filter-action"
            data-testid="audit-filter-action"
            value={action}
            onChange={(e) => updateFilter({ action: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {actionFacets.map((f) => (
              <option key={f.action} value={f.action}>
                {labelFor(f.action)}（{f.count}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="主体" htmlFor="audit-filter-actor" hint="admin / kiosk:... で始まる識別子">
          <input
            id="audit-filter-actor"
            type="text"
            data-testid="audit-filter-actor"
            value={actor}
            onChange={(e) => updateFilter({ actor: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="キーワード" htmlFor="audit-filter-keyword" hint="対象種別 / ID など">
          <input
            id="audit-filter-keyword"
            type="text"
            data-testid="audit-filter-keyword"
            value={keyword}
            onChange={(e) => updateFilter({ keyword: e.target.value })}
            style={inputStyle}
          />
        </Field>
        {hasFilter ? (
          <Button variant="secondary" onClick={reset} data-testid="audit-filter-reset">
            条件をクリア
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          data-testid="audit-csv-export"
        >
          CSV エクスポート
        </Button>
      </div>

      <p data-testid="audit-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0 }}>
        {logs.length} 件中 {filtered.length} 件を表示
      </p>

      <DataTable
        testId="audit-table"
        columns={columns}
        rows={paged.items}
        rowKey={(l) => l.id}
        rowTestId={() => 'audit-row'}
        sort={sort}
        onSortChange={setSort}
        emptyMessage={
          hasFilter ? '条件に一致する監査ログはありません。' : 'まだ監査ログはありません。'
        }
      />

      {paged.pageCount > 1 ? (
        <div
          data-testid="audit-pagination"
          style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}
        >
          <Button
            variant="secondary"
            data-testid="audit-page-prev"
            disabled={paged.page <= 1}
            onClick={() => setMany({ page: String(paged.page - 1) })}
          >
            前へ
          </Button>
          <span style={{ fontSize: font.small, opacity: 0.8 }} data-testid="audit-page-label">
            {paged.page} / {paged.pageCount} ページ
          </span>
          <Button
            variant="secondary"
            data-testid="audit-page-next"
            disabled={paged.page >= paged.pageCount}
            onClick={() => setMany({ page: String(paged.page + 1) })}
          >
            次へ
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${color.borderStrong}`,
  background: color.surface,
  color: color.text,
  fontSize: font.small,
};
