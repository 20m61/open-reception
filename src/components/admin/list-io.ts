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
