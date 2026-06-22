'use client';

import { useMemo } from 'react';
import type { AuditAction, AuditLog } from '@/domain/reception/log';
import { filterAuditLogs, type AuditFilter } from '@/domain/audit/audit-filter';
import { Button, color, font, radius, space } from '@/components/admin/ui';
import { useQueryParams } from '@/components/admin/use-query-params';

/**
 * 監査ログの検索・フィルタ表示 (issue #89, increment 2)。
 *
 * read 専用。サーバから渡された監査ログ（PII を含まない）をクライアント側で
 * 期間・アクション種別・主体・キーワードでフィルタする。絞り込みロジックは
 * 純関数 filterAuditLogs に委譲し、本コンポーネントは入力 UI と描画のみを担う。
 *
 * 監査アクションは新規追加しない。表示ラベルは呼び出し側が渡す非網羅マップ
 * （未登録は raw 文字列フォールバック）を使う。
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
  const labelFor = (a: string) => actionLabels[a as AuditAction] ?? a;
  const hasFilter = Boolean(start || end || action || actor || keyword);

  const reset = () => setMany({ start: '', end: '', action: '', actor: '', keyword: '' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.md }}>
      <div
        data-testid="audit-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, alignItems: 'flex-end' }}
      >
        <FilterField label="開始日">
          <input
            type="date"
            data-testid="audit-filter-start"
            value={start}
            onChange={(e) => setMany({ start: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        <FilterField label="終了日">
          <input
            type="date"
            data-testid="audit-filter-end"
            value={end}
            onChange={(e) => setMany({ end: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        <FilterField label="操作種別">
          <select
            data-testid="audit-filter-action"
            value={action}
            onChange={(e) => setMany({ action: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {actionFacets.map((f) => (
              <option key={f.action} value={f.action}>
                {labelFor(f.action)}（{f.count}）
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="主体">
          <input
            type="text"
            data-testid="audit-filter-actor"
            placeholder="admin / kiosk:..."
            value={actor}
            onChange={(e) => setMany({ actor: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        <FilterField label="キーワード（対象など）">
          <input
            type="text"
            data-testid="audit-filter-keyword"
            placeholder="対象種別 / ID など"
            value={keyword}
            onChange={(e) => setMany({ keyword: e.target.value })}
            style={inputStyle}
          />
        </FilterField>
        {hasFilter ? (
          <Button variant="secondary" onClick={reset} data-testid="audit-filter-reset">
            条件をクリア
          </Button>
        ) : null}
      </div>

      <p data-testid="audit-count" style={{ opacity: 0.7, fontSize: font.small, margin: 0 }}>
        {logs.length} 件中 {filtered.length} 件を表示
      </p>

      {filtered.length === 0 ? (
        <p data-testid="audit-empty" style={{ opacity: 0.7 }}>
          {hasFilter ? '条件に一致する監査ログはありません。' : 'まだ監査ログはありません。'}
        </p>
      ) : (
        <table
          data-testid="audit-table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: font.body }}
        >
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: `1px solid ${color.borderStrong}` }}>
              <th style={cell}>日時</th>
              <th style={cell}>操作</th>
              <th style={cell}>主体</th>
              <th style={cell}>対象</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((log) => (
              <tr key={log.id} data-testid="audit-row" style={{ borderBottom: `1px solid ${color.border}` }}>
                <td style={cell}>{new Date(log.at).toLocaleString('ja-JP')}</td>
                <td style={cell}>{labelFor(log.action)}</td>
                <td style={cell}>{log.actor}</td>
                <td style={cell}>
                  {log.targetType ?? '-'}
                  {log.targetId ? <span style={{ opacity: 0.6 }}> {log.targetId}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

const cell: React.CSSProperties = { padding: '8px 12px' };
