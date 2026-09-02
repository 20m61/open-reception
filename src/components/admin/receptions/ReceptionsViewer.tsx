'use client';

import { useMemo } from 'react';
import type { ReceptionLog } from '@/domain/reception/log';
import { RECEPTION_PURPOSES, type CallOutcome } from '@/domain/reception/session';
import { Button, DataTable, Field, type Column } from '@/components/admin/ui';
import { color, font, radius, space } from '@/components/admin/ui/tokens';
import { useQueryParams } from '@/components/admin/use-query-params';
import {
  failureReasonLabel,
  filterReceptionLogs,
  kioskFacets,
  paginate,
  receptionLogsToCsv,
  type ReceptionLogFilter,
} from './logic';
import { sortRows } from '@/components/admin/list-io';
import { useTableSort } from '@/components/admin/use-table-sort';

const PAGE_SIZE = 20;

/**
 * 受付履歴の検索・フィルタ・ページング・CSV エクスポート (issue #330 item2)。
 *
 * 監査ログ（`AuditLogViewer`）と同じ設計を踏襲する: 検索/フィルタ状態は URL クエリを
 * 真実源にし（issue #94）、絞り込みロジックは純関数 `filterReceptionLogs` に委譲する。
 * ReceptionLog は元々来訪者の PII を含まない設計なので、CSV にも PII は含まれない。
 *
 * CSV はサーバ API を新設せず、既に取得済みの（絞り込み後の）ログをクライアント側で
 * Blob に変換してダウンロードする（#330 スコープ方針: 可能な限りクライアント側で完結）。
 */
function purposeLabel(purposeId?: string): string {
  return RECEPTION_PURPOSES.find((p) => p.id === purposeId)?.label ?? '-';
}

export function ReceptionsViewer({
  logs,
  outcomeLabel,
  outcomeColor,
}: {
  logs: readonly ReceptionLog[];
  outcomeLabel: Record<CallOutcome, string>;
  outcomeColor: Record<CallOutcome, string>;
}) {
  const { get, setMany } = useQueryParams();
  const start = get('start');
  const end = get('end');
  const outcome = get('outcome');
  const kioskId = get('kiosk');
  const pageParam = get('page');

  const filter: ReceptionLogFilter = useMemo(
    () => ({
      start: start || undefined,
      end: end || undefined,
      outcomes: outcome ? [outcome as CallOutcome] : undefined,
      kioskId: kioskId || undefined,
    }),
    [start, end, outcome, kioskId],
  );

  const filtered = useMemo(() => filterReceptionLogs(logs, filter), [logs, filter]);
  const facets = useMemo(() => kioskFacets(logs), [logs]);
  const { sort, setSort } = useTableSort();
  const hasFilter = Boolean(start || end || outcome || kioskId);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });
  const reset = () =>
    setMany({ start: '', end: '', outcome: '', kiosk: '', page: '', sort: '', sortDir: '' });

  const downloadCsv = () => {
    const csv = receptionLogsToCsv(filtered, { outcomeLabel, purposeLabel });
    // Excel（Windows/日本語ロケール）で文字化けしないよう UTF-8 BOM を付与する。
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `receptions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns = useMemo<Column<ReceptionLog>[]>(
    () => [
      {
        key: 'startedAt',
        header: '開始日時',
        cell: (l) => new Date(l.startedAt).toLocaleString('ja-JP'),
        sortValue: (l) => l.startedAt,
      },
      { key: 'kiosk', header: '端末', cell: (l) => l.kioskId, sortValue: (l) => l.kioskId },
      { key: 'purpose', header: '目的', cell: (l) => purposeLabel(l.purpose) },
      { key: 'target', header: '呼び出し先', cell: (l) => l.targetLabel ?? '-' },
      {
        key: 'outcome',
        header: '結果',
        cellStyle: (l) => ({ color: outcomeColor[l.outcome], fontWeight: 700 }),
        cell: (l) => (
          <>
            {outcomeLabel[l.outcome]}
            {l.failureReason ? (
              <span style={{ opacity: 0.7, fontWeight: 400 }} title={`内部コード: ${l.failureReason}`}>
                （{failureReasonLabel(l.failureReason)}）
              </span>
            ) : null}
          </>
        ),
      },
      {
        key: 'duration',
        header: '所要',
        cell: (l) => `${Math.round(l.durationMs / 1000)}秒`,
        // 表示は「秒」だが、比較は元の ms で行う（文字列比較にすると 9秒 > 10秒 になる）。
        sortValue: (l) => l.durationMs,
      },
      { key: 'fallback', header: '代替導線', cell: (l) => (l.fallbackUsed ? 'あり' : '-') },
    ],
    [outcomeLabel, outcomeColor],
  );

  // 並べ替えてからページを切る（逆にすると 1 ページぶんだけが並び替わる）。
  const sorted = useMemo(() => sortRows(filtered, columns, sort), [filtered, columns, sort]);
  const paged = useMemo(
    () => paginate(sorted, Number(pageParam) || 1, PAGE_SIZE),
    [sorted, pageParam],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      <div
        data-testid="receptions-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }}
      >
        <Field label="開始日" htmlFor="receptions-filter-start">
          <input
            type="date"
            id="receptions-filter-start"
            data-testid="receptions-filter-start"
            value={start}
            onChange={(e) => updateFilter({ start: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="終了日" htmlFor="receptions-filter-end">
          <input
            type="date"
            id="receptions-filter-end"
            data-testid="receptions-filter-end"
            value={end}
            onChange={(e) => updateFilter({ end: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="結果" htmlFor="receptions-filter-outcome">
          <select
            id="receptions-filter-outcome"
            data-testid="receptions-filter-outcome"
            value={outcome}
            onChange={(e) => updateFilter({ outcome: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {(Object.keys(outcomeLabel) as CallOutcome[]).map((o) => (
              <option key={o} value={o}>
                {outcomeLabel[o]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="端末" htmlFor="receptions-filter-kiosk">
          <select
            id="receptions-filter-kiosk"
            data-testid="receptions-filter-kiosk"
            value={kioskId}
            onChange={(e) => updateFilter({ kiosk: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {facets.map((f) => (
              <option key={f.kioskId} value={f.kioskId}>
                {f.kioskId}（{f.count}）
              </option>
            ))}
          </select>
        </Field>
        {hasFilter ? (
          <Button variant="secondary" onClick={reset} data-testid="receptions-filter-reset">
            条件をクリア
          </Button>
        ) : null}
        <Button
          variant="secondary"
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          data-testid="receptions-csv-export"
        >
          CSV エクスポート
        </Button>
      </div>

      <p data-testid="receptions-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0 }}>
        {logs.length} 件中 {filtered.length} 件を表示
      </p>

      <DataTable
        testId="receptions-table"
        columns={columns}
        rows={paged.items}
        rowKey={(l) => l.id}
        rowTestId={() => 'reception-row'}
        sort={sort}
        onSortChange={setSort}
        emptyMessage={hasFilter ? '条件に一致する受付履歴はありません。' : 'まだ受付履歴はありません。'}
      />

      {paged.pageCount > 1 ? (
        <div
          data-testid="receptions-pagination"
          style={{ display: 'flex', gap: space.sm, alignItems: 'center' }}
        >
          <Button
            variant="secondary"
            data-testid="receptions-page-prev"
            disabled={paged.page <= 1}
            onClick={() => setMany({ page: String(paged.page - 1) })}
          >
            前へ
          </Button>
          <span style={{ fontSize: font.small, opacity: 0.8 }} data-testid="receptions-page-label">
            {paged.page} / {paged.pageCount} ページ
          </span>
          <Button
            variant="secondary"
            data-testid="receptions-page-next"
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
