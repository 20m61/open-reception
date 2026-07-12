import type { HTMLAttributes, ReactNode } from 'react';
import { color, font, space } from './tokens';
import { EmptyState } from './EmptyState';

/**
 * 管理画面 共有データテーブル (issue #92, increment 1)。
 *
 * 既存 dashboard/RecentCalls 等の素朴な table 描画を正準化した汎用版。
 * 列定義（columns）でヘッダとセル描画を宣言し、空配列では EmptyState を出す。
 * 行 PII を持ち込まない方針は呼び出し側の責務（本コンポーネントは描画のみ）。
 *
 * increment 3: 各 *Manager の素のテーブルを寄せるため、行 `<tr>` / セル `<td>` の
 * data-testid と行レベル属性（draggable / onDrop 等）を保てる上書き口を追加した。
 *
 * 狭幅（iPad 縦・390px 等）での破綻対策 (issue #330 item5): 列が多い表を `width: 100%`
 * のまま狭い画面に収めようとすると、table の auto レイアウトが各セルを極端に狭く
 * 潰しにかかり、CJK テキストは語間の空白なしにどこでも改行できてしまうため 1 文字ずつ
 * 縦に積まれる「縦書き化」のような見た目になり判読・操作ができなくなる（#94 AC 未達）。
 * 対策として (1) 表全体を `overflow-x: auto` のラッパで包み、(2) `min-width: max-content`
 * で「一切折り返さなかった場合の自然な内容幅」を表の最小幅として保証する。結果として、
 * 広い画面では従来通り全幅、狭い画面では列が潰れず横スクロールで判読・操作できる
 * （縦書き化しない）。セル自体の折り返し可否（white-space）は変更しない＝既存の
 * 複雑なセル内容（ボタン群・インライン編集フォーム等）の見た目に影響しない。
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
  /** セル `<td>` に付与する data-testid（移行元のセル testid を保つための上書き口）。 */
  cellTestId?: (row: Row) => string | undefined;
  /** セル `<td>` の追加スタイル（移行元のセル色などを保つ）。 */
  cellStyle?: (row: Row) => React.CSSProperties | undefined;
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'データがありません。',
  testId = 'ui-data-table',
  rowTestId,
  rowProps,
}: {
  columns: ReadonlyArray<Column<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row, index: number) => string;
  emptyMessage?: string;
  testId?: string;
  /** 各行 `<tr>` に付与する data-testid（移行元の行 testid を保つための上書き口）。 */
  rowTestId?: (row: Row, index: number) => string | undefined;
  /** 各行 `<tr>` に追加で付与する属性（draggable / onDrop 等の行レベル挙動の移行用）。 */
  rowProps?: (
    row: Row,
    index: number,
  ) => HTMLAttributes<HTMLTableRowElement> & { draggable?: boolean };
}) {
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} testId={`${testId}-empty`} />;
  }
  // 狭幅では横スクロールで全列を見せる。スクロール領域はキーボードでも到達できるよう
  // tabIndex=0 + role="region" を付与する（WCAG 2.1.1: マウス/タッチの無い利用者でも
  // スクロールできる。#330 レビュー）。
  return (
    <div
      data-testid={`${testId}-scroll`}
      role="region"
      aria-label="テーブル（横スクロール可）"
      tabIndex={0}
      style={{ overflowX: 'auto' }}
    >
      <table
        data-testid={testId}
        style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: font.body }}
      >
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: `1px solid ${color.borderStrong}` }}>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  padding: `${space.xs}px ${space.sm}px`,
                  textAlign: c.align ?? 'left',
                  opacity: 0.7,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const extra = rowProps?.(row, i);
            return (
              <tr
                key={rowKey(row, i)}
                data-testid={rowTestId?.(row, i)}
                {...extra}
                style={{ borderBottom: `1px solid ${color.border}`, ...extra?.style }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-testid={c.cellTestId?.(row)}
                    style={{
                      padding: `${space.xs}px ${space.sm}px`,
                      textAlign: c.align ?? 'left',
                      ...c.cellStyle?.(row),
                    }}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
