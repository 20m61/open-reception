import type { ReactNode } from 'react';
import { color, font, space } from './tokens';
import { EmptyState } from './EmptyState';

/**
 * 管理画面 共有データテーブル (issue #92, increment 1)。
 *
 * 既存 dashboard/RecentCalls 等の素朴な table 描画を正準化した汎用版。
 * 列定義（columns）でヘッダとセル描画を宣言し、空配列では EmptyState を出す。
 * 行 PII を持ち込まない方針は呼び出し側の責務（本コンポーネントは描画のみ）。
 */
export type Column<Row> = {
  /** 列の安定キー。 */
  key: string;
  /** ヘッダ表示。 */
  header: ReactNode;
  /** セル描画。 */
  cell: (row: Row) => ReactNode;
  /** 右寄せ（数値列など）。既定は左寄せ。 */
  align?: 'left' | 'right' | 'center';
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'データがありません。',
  testId = 'ui-data-table',
}: {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row, index: number) => string;
  emptyMessage?: string;
  testId?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} testId={`${testId}-empty`} />;
  }
  return (
    <table data-testid={testId} style={{ width: '100%', borderCollapse: 'collapse', fontSize: font.body }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: `1px solid ${color.borderStrong}` }}>
          {columns.map((c) => (
            <th
              key={c.key}
              style={{ padding: `${space.xs}px ${space.sm}px`, textAlign: c.align ?? 'left', opacity: 0.7, fontWeight: 700 }}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={rowKey(row, i)} style={{ borderBottom: `1px solid ${color.border}` }}>
            {columns.map((c) => (
              <td key={c.key} style={{ padding: `${space.xs}px ${space.sm}px`, textAlign: c.align ?? 'left' }}>
                {c.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
