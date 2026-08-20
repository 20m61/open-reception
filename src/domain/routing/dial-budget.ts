/**
 * 発信 1 手あたりの呼出予算 (#647 / #646)。
 *
 * `dialExpiresAt` は「webhook が一度も来ない場合」の最後の砦で、`/status` の読み時に
 * 遅延評価される（`@/domain/call/call-resolution`）。**1 手目と 2 手目で規則が違うと
 * 事故になる**ので、余裕の値と計算をここ 1 箇所に置く。
 */

/**
 * 呼出予算に足す余裕（秒） (#647)。
 *
 * 期限は「呼出タイムアウト（`ringing_timer`）＋ webhook の配送遅延」を見込む。短すぎると
 * **鳴っている最中に打ち切る**。長すぎると来訪者が無駄に待つ。Vonage の呼出は数十秒なので
 * 30 秒あれば配送遅延を吸収できる。
 */
export const DIAL_BUDGET_MARGIN_SECONDS = 30;

/** この 1 手の呼出予算の期限（ISO）。 */
export function dialExpiresAtFrom(dialedAt: Date, timeoutSeconds: number): string {
  return new Date(
    dialedAt.getTime() + (timeoutSeconds + DIAL_BUDGET_MARGIN_SECONDS) * 1000,
  ).toISOString();
}
