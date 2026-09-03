/**
 * VRM の fallback 表示を出すかの判定 (#932)。
 *
 * ## なぜ「失敗した」ではなく「どの URL で失敗した」を持つのか
 *
 * 以前は `failed: boolean` を持っており、**一度立つと二度と戻らなかった**。
 * `vrmUrl` を差し替えても `showFallback` は真のままで、運用者が管理画面でアセットを
 * 直しても端末は再読込まで静止画のままになる。
 *
 * 🔴 **`useEffect` の冒頭で `setFailed(false)` する、では直らない。** effect は
 * `if (!canvas) return;` を**リセットより前**に持っており、fallback 表示中は canvas が
 * DOM に無い（`showFallback` が真の枝は `<canvas>` を描かない）ので `canvasRef.current`
 * は `null` になり、**リセットへ到達しないまま return する**。再試行の経路が構造的に
 * 閉じているので、「戻し忘れ」ではなく**状態の持ち方**を直す必要がある。
 *
 * 失敗を URL に紐づけると、`vrmUrl` が変わった時点で判定が同じレンダーで偽になり、
 * canvas が mount されてから effect が走る。リセットを書き忘れる余地が無くなる。
 *
 * **同一 URL の自動リトライは対象外**（#932 Non-goals）。同じ URL は失敗したままにする ——
 * バックオフ無しに繰り返すと、落ちている配信元へ毎レンダー撃ちに行くことになる。
 */
export type VrmFallbackInput = {
  /** 表示すべき VRM の URL。未設定なら WebGL を初期化しない（既定の受付画面を軽量に保つ）。 */
  readonly vrmUrl?: string;
  /** 読込に失敗した URL。`vrmUrl` と一致する間だけ fallback を出す。 */
  readonly failedUrl?: string;
};

/** fallback（静止画 or 非表示）を出すか。 */
export function shouldShowVrmFallback({ vrmUrl, failedUrl }: VrmFallbackInput): boolean {
  if (!vrmUrl) return true;
  return failedUrl === vrmUrl;
}
