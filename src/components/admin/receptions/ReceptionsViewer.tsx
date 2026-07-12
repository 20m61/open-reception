'use client';

import { useMemo } from 'react';
import type { ReceptionLog } from '@/domain/reception/log';
import { RECEPTION_PURPOSES, type CallOutcome } from '@/domain/reception/session';
import { Button, DataTable, type Column } from '@/components/admin/ui';
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
  const paged = useMemo(
    () => paginate(filtered, Number(pageParam) || 1, PAGE_SIZE),
    [filtered, pageParam],
  );
  const hasFilter = Boolean(start || end || outcome || kioskId);

  // フィルタ変更時はページを 1 に戻す（絞り込み後に空ページへ迷い込まないようにする）。
  const updateFilter = (updates: Record<string, string>) => setMany({ ...updates, page: '' });
  const reset = () => setMany({ start: '', end: '', outcome: '', kiosk: '', page: '' });

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
      { key: 'startedAt', header: '開始日時', cell: (l) => new Date(l.startedAt).toLocaleString('ja-JP') },
      { key: 'kiosk', header: '端末', cell: (l) => l.kioskId },
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
      { key: 'duration', header: '所要', cell: (l) => `${Math.round(l.durationMs / 1000)}秒` },
      { key: 'fallback', header: '代替導線', cell: (l) => (l.fallbackUsed ? 'あり' : '-') },
    ],
    [outcomeLabel, outcomeColor],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      <div
        data-testid="receptions-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }}
      >
        <FilterField label="開始日">
          <input
            type="date"
            data-testid="receptions-filter-start"
            value={start}
            onChange={(e) => updateFilter({ start: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        <FilterField label="終了日">
          <input
            type="date"
            data-testid="receptions-filter-end"
            value={end}
            onChange={(e) => updateFilter({ end: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        <FilterField label="結果">
          <select
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
        </FilterField>
        <FilterField label="端末">
          <select
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
        </FilterField>
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

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: font.caption, opacity: 0.85 }}>
      <span>{label}</span>
      {children}
    </label>
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
