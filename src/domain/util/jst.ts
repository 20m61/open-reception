/**
 * JST（Asia/Tokyo, UTC+9・DST なし）の暦日/暦月ヘルパ (issue #254)。
 *
 * ランタイム TZ に依存せず「本日/今月」を JST で判定するため、日付境界のロジックをここへ集約する
 * （dashboard-summary の「本日」・usage/cost の「今月/前月/日次トレンド/月進捗」で共有）。TZ 修正が
 * 必要になっても1箇所で済み、指標間の JST 境界が食い違わない。
 *
 * 実装方針: UTC+9 の固定オフセットを足してから UTC 暦フィールド（ISO 文字列 / getUTC*）を読む。
 * 日本は DST が無いため固定オフセットで正確。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** エポック ms を JST 暦日キー（YYYY-MM-DD）へ。無効な ms は null。 */
export function jstDayKey(ms: number): string | null {
  if (Number.isNaN(ms)) return null;
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `now` を含む JST 暦月の年・月（0 始まり）。 */
export function jstYearMonth(now: Date): { y: number; m: number } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() };
}

/** JST 暦月 (y, m) の月初 00:00 JST を UTC ISO で返す（Date.UTC が 12↔1 月の桁上げ/下げを処理）。 */
export function jstMonthStartIso(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 1) - JST_OFFSET_MS).toISOString();
}

/** `now` の JST 暦日（月内日, 1..31）。無効な now は NaN。 */
export function jstDayOfMonth(now: Date): number {
  const t = now.getTime();
  if (Number.isNaN(t)) return NaN;
  return new Date(t + JST_OFFSET_MS).getUTCDate();
}

/** JST 暦月 (y, m) の総日数。 */
export function daysInJstMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}
