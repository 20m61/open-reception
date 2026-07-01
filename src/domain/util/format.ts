/** 表示用の純粋な整形ヘルパ。管理画面で共有する（重複と精度乖離を避ける）。 */

/** 割合（0〜1）をパーセント文字列にする（小数第1位）。null は「—」。 */
export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 1000) / 10}%`;
}
