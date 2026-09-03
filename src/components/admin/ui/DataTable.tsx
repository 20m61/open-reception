import type { HTMLAttributes, ReactNode } from 'react';
import { color, font, space } from './tokens';
import { EmptyState } from './EmptyState';
import { ariaSortFor, nextSortState, type SortState } from '../list-io';
import { resolveAdminReadState } from '../read-state';
import { Skeleton } from './Skeleton';

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
  /**
   * 並べ替えの比較キー。**指定した列だけ**ソート可能になる (#909 / 課題 18)。
   *
   * 並べ替えそのものは `list-io.ts` の `sortRows` が行い、呼び出し側が
   * `sortRows` → `paginate` の順に通す。ここで並べ替えると**ページを切ったあとの
   * 20 件だけが並び替わる**ため。
   */
  sortValue?: (row: Row) => string | number;
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'データがありません。',
  testId = 'ui-data-table',
  rowTestId,
  rowProps,
  sort,
  onSortChange,
  loaded,
  failed,
  failureMessage,
  scrollRegionLabel,
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
  /** 現在の並べ替え。`onSortChange` と対で渡す（片方だけではヘッダは押せない）。 */
  sort?: SortState;
  /** ヘッダを押したときの遷移先。`undefined` は並べ替え解除。 */
  onSortChange?: (next: SortState | undefined) => void;
  /**
   * 対象のデータが載っているか (#896)。**省略すると今までどおり**「常に読めている」
   * とみなし、0 件は `EmptyState` になる（移行を一度に強制しないため）。
   */
  loaded?: boolean;
  /** 直近の読み取りが失敗したか。`loaded` と対で渡す。 */
  failed?: boolean;
  /** 失敗時の本文。何が取れなかったかを画面ごとに書く。 */
  failureMessage?: string;
  /**
   * 横スクロール領域のアクセシブル名 (#896 レビュー M4)。
   *
   * 🔴 **1 ページに表が複数あるなら必ず渡す。** 既定の固定文言のままだと、
   * `MaintenanceStatus`（表 4 つ）では**同じ名前の region landmark が 4 つ**並び、
   * スクリーンリーダーの landmark 一覧が「テーブル（横スクロール可）」×4 になって
   * どれがどの表か判別できない（axe の `landmark-unique`）。
   */
  scrollRegionLabel?: string;
}) {
  if (rows.length === 0) {
    /*
     * 「まだ読めていない」と「0 件だった」を混ぜない (#896 / 課題 06)。
     *
     * 取得できていないのに「登録された部署はありません。」と**断定**すると、
     * 利用者は「無い」と信じて操作をやめる。失敗しても行は空のままなので、
     * `loaded` だけを見ると**失敗が永遠の「読み込み中」に化ける** ——
     * 状態の決め方は `AdminReadGate`（#870）と同じ `resolveAdminReadState` に委ねる。
     */
    const state = resolveAdminReadState({ loaded: loaded ?? true, failed: failed ?? false });
    if (state === 'loading') {
      return (
        <div
          data-testid={`${testId}-loading`}
          /*
           * 読み上げへ「待っている」を届ける (#896 レビュー M4)。同じ設計体系の
           * `Skeleton` の `SkeletonBlock` は既に `role="status" aria-busy aria-live` を
           * 持っており、ここだけ黙っているのは不整合だった。
           */
          role="status"
          aria-busy="true"
          aria-live="polite"
          style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}
        >
          {/* 行の形で待たせる（「何かが出る場所」だと分かる）。読み上げは下の text が担う。 */}
          {/* testId は表ごと・行ごとに一意にする（strict mode の locator が使えるように）。 */}
          <Skeleton height={20} testId={`${testId}-skeleton-1`} />
          <Skeleton height={20} testId={`${testId}-skeleton-2`} />
          <span style={{ fontSize: font.small, color: color.muted }}>読み込み中…</span>
        </div>
      );
    }
    if (state === 'failed') {
      return (
        /*
         * 🔴 **失敗は読み上げへ届ける (#966)。** 待ち状態は `role="status"` を持つのに、
         * 失敗だけが黙っていた —— 画面を見ていない利用者には「まだ来ない」と区別が付かない。
         * `EmptyState` は `<div>` なので、外側で `role="alert"` を持たせる。
         */
        <div role="alert">
          <EmptyState
            testId={`${testId}-failed`}
            message={failureMessage ?? '一覧を読み込めませんでした。'}
          />
        </div>
      );
    }
    return <EmptyState message={emptyMessage} testId={`${testId}-empty`} />;
  }
  // 狭幅では横スクロールで全列を見せる。スクロール領域はキーボードでも到達できるよう
  // tabIndex=0 + role="region" を付与する（WCAG 2.1.1: マウス/タッチの無い利用者でも
  // スクロールできる。#330 レビュー）。
  return (
    <div
      data-testid={`${testId}-scroll`}
      role="region"
      aria-label={scrollRegionLabel ?? 'テーブル（横スクロール可）'}
      tabIndex={0}
      style={{ overflowX: 'auto' }}
    >
      <table
        data-testid={testId}
        style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: font.body }}
      >
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: `1px solid ${color.borderStrong}` }}>
            {columns.map((c) => {
              /*
               * ソート可能に**見せる**条件は 3 つ揃ったときだけ (#909 / 課題 18)。
               * 列が比較キーを持ち、現在の状態が渡され、遷移先を受け取る先がある。
               * どれか欠けたまま押せるように見せると、押しても何も起きないヘッダになる。
               */
              const sortable = Boolean(c.sortValue && onSortChange);
              return (
                <th
                  key={c.key}
                  aria-sort={sortable ? ariaSortFor(sort, c.key) : undefined}
                  style={{
                    padding: `${space.xs}px ${space.sm}px`,
                    textAlign: c.align ?? 'left',
                    opacity: 0.7,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {sortable ? (
                    <button
                      type="button"
                      data-testid={`${testId}-sort-${c.key}`}
                      onClick={() => onSortChange?.(nextSortState(sort, c.key))}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        font: 'inherit',
                        color: 'inherit',
                        cursor: 'pointer',
                      }}
                    >
                      {c.header}
                      {/* 向きは aria-sort が正。記号は目で読む人のための冗長表現。 */}
                      <span aria-hidden>
                        {sort?.key === c.key ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
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
