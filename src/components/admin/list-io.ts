/**
 * 管理画面 一覧共通ユーティリティ（ページング / CSV）(issue #330 item2 残増分)。
 *
 * 受付履歴（`receptions/logic.ts`）・監査ログ（`src/domain/audit/audit-filter.ts`）で確立した
 * ページング/CSV/JST 日付境界の流儀を、来訪予約・在館状況・拠点・端末の各一覧へ拡張する際の
 * 共有実装として切り出す。副作用なし・React/DOM 非依存（node 環境でユニットテスト可能）。
 */

/** 一覧のページング結果。 */
export type Page<T> = {
  items: T[];
  /** クランプ後の実際のページ番号（1 始まり）。 */
  page: number;
  /** 総ページ数（最低 1）。 */
  pageCount: number;
  /** 絞り込み後の総件数。 */
  total: number;
};

/** 配列を 1 始まりのページに分割する純関数。ページ番号は有効範囲にクランプし、0 除算しない。 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const startIndex = (clamped - 1) * pageSize;
  return {
    items: items.slice(startIndex, startIndex + pageSize),
    page: clamped,
    pageCount,
    total,
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 日付フィルタの境界は **JST 暦日**で解釈する（受付履歴フィルタと同方針, #254）。
 * `start`（含む下限）を epoch ms に。date-only（YYYY-MM-DD）は JST 00:00、時刻付き ISO はその瞬間。
 */
export function jstStartBoundary(start: string): number {
  const s = start.trim();
  if (DATE_ONLY.test(s)) return Date.parse(`${s}T00:00:00+09:00`);
  return new Date(start).getTime();
}

/** `end`（その JST 暦日の終わりまで含む上限）を epoch ms に。時刻付き ISO はその瞬間。 */
export function jstEndBoundary(end: string): number {
  const e = end.trim();
  if (DATE_ONLY.test(e)) {
    const dayStart = Date.parse(`${e}T00:00:00+09:00`);
    return Number.isNaN(dayStart) ? Number.POSITIVE_INFINITY : dayStart + 86_400_000 - 1;
  }
  const t = new Date(end).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * RFC4180 に沿って 1 セル値をエスケープする（カンマ・改行・ダブルクォートを含む場合のみクォート）。
 * あわせて Excel/Sheets の数式インジェクションを無害化する（#330 レビュー）: `=`/`+`/`@` で始まる、
 * または `-` の後に式が続くセルは先頭にタブを付け、式として評価させない。自由入力（氏名・会社名・
 * 拠点名・設置場所等）は管理者/来訪予約時の入力に由来しうるため対象になりうる。
 */
export function csvCell(value: string): string {
  const isFormula = /^[=+@]/.test(value) || (value.startsWith('-') && value !== '-' && !/^-?\d/.test(value));
  const guarded = isFormula ? `\t${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** ヘッダ行 + データ行から CSV 文字列（末尾改行付き）を組み立てる純関数。 */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

/** 並べ替えの状態。列キーと向き。 */
export type SortState = { readonly key: string; readonly direction: 'asc' | 'desc' };

/** 並べ替えに使える列（`DataTable` の `Column` から必要な部分だけ）。 */
export type SortableColumn<Row> = {
  readonly key: string;
  readonly sortValue?: (row: Row) => string | number;
};

/**
 * 一覧を安定に並べ替える純関数 (#909 / 課題 18)。
 *
 * 🔴 **`DataTable` の側で並べ替えない。** 行を渡す側がページングもするので、描画の直前で
 * 並べ替えると**ページを切ったあとの 20 件だけが並び替わる** —— 利用者から見ると
 * 「並べ替えたのに 2 ページ目に小さい値が残っている」という壊れ方になる。
 * 呼び出し側が `sortRows` → `paginate` の順に通す。
 *
 * 並べ替えは**安定**である（同値の行の相対順序を保つ）。取得順に意味がある一覧
 * （監査ログは新しい順）で、同値のかたまりの中の順序が毎回変わると読みにくい。
 * `Array.prototype.sort` は ES2019 以降**仕様として安定**なので、比較関数に
 * 添字の tie-break を足す必要は無い（足しても振る舞いは変わらない ——
 * 実際に変異検証で「等価な変異」として生存した）。
 *
 * 指定が無い / 列が無い / その列がソート不可のときは**元の配列をそのまま返す**
 * （既定の順序を勝手に変えない）。
 */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly SortableColumn<Row>[],
  sort: SortState | undefined,
): readonly Row[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.key === sort.key);
  const sortValue = column?.sortValue;
  if (!sortValue) return rows;

  const sign = sort.direction === 'desc' ? -1 : 1;
  // 複製してから並べ替える。呼び出し側は `useMemo` の入力を共有しているので、
  // 元の配列を破壊すると**並べ替えていない一覧まで順序が変わる**。
  return [...rows].sort((a, b) => {
    const av = sortValue(a);
    const bv = sortValue(b);
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return 0;
  });
}

/**
 * ヘッダを押したときの次の状態。`asc` → `desc` → 解除（`undefined`）で 1 周する。
 *
 * 解除できることが要る —— 一覧の**既定の順序に意味がある**（監査ログは新しい順、
 * 部署は表示順）ので、並べ替えたあと元へ戻せないと情報が失われる。
 */
export function nextSortState(current: SortState | undefined, key: string): SortState | undefined {
  if (current?.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return undefined;
}

/** `aria-sort` の値。 */
export function ariaSortFor(current: SortState | undefined, key: string): 'ascending' | 'descending' | 'none' {
  if (current?.key !== key) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}
