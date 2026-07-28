/**
 * 無操作リセットの上限解決 (issue #125 / #324)。
 *
 * 公共端末に入力途中の個人情報を残さないため、操作途中で離席したら一定時間で待機画面へ
 * 戻す。上限は状態によって変える:
 *   - 選択・入力・確認画面 … `INACTIVITY_RESET_MS`
 *   - connected（担当者応答済み・来訪待ち）… `CONNECTED_INACTIVITY_RESET_MS`
 *     「操作は不要です」と案内しその場で待つ画面なので長めに取り、正当な待機の誤リセットを避ける。
 *
 * E2E 用のクエリ上書きは 2 段階で、**より具体的な指定が勝つ**:
 *   - `?inactivityMs=`          … 全状態に一律（既存の流儀）
 *   - `?connectedInactivityMs=` … connected のみ
 *
 * connected 限定の口を用意しているのは、一律短縮だと connected へ至るまでの操作すべてが
 * 同じ短い上限に晒され、1 ステップでも遅れると警告オーバーレイが click を横取りして
 * テストが落ちるため（負荷依存のフレーク）。「フロー中は本番既定・connected だけ短縮」を
 * 表現できるようにして、競合を構造的に消す。
 */

/**
 * 操作途中で離席した場合に、無操作のまま待機画面へ戻すまでの時間 (issue #125)。
 * 公共端末に入力途中の個人情報を残さないための上限。
 */
export const INACTIVITY_RESET_MS = 60000;

/**
 * connected（担当者応答済み・来訪待ち）画面の無操作リセット上限 (#324)。
 * 「操作は不要です」と案内し来訪者はその場で担当者の到着を待つため、選択/入力画面より長めに取り、
 * 正当な待機中の誤リセットを避ける。離席した場合はこの時間で PII を破棄して待機へ戻す。
 * 待機中の来訪者は警告カウントダウンで「続ける」を押せば延長できる。
 */
export const CONNECTED_INACTIVITY_RESET_MS = 120000;

/**
 * リセット前にカウントダウン警告を出す時間 (issue #125 UX, "don't surprise-expire")。
 * 残り WARNING ミリ秒で警告を表示し、来訪者が操作すれば延長する。
 */
export const INACTIVITY_WARNING_MS = 10000;

/** 正の有限数のみを採用する。0・負値・非数は「未指定」とみなす。 */
function positiveMs(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 無操作リセットの上限を解決する。純関数（`window` を直接読まない）。
 *
 * @param input.search 現在の URL クエリ文字列（`window.location.search` 相当）。
 * @param input.state  現在のフロー状態。`connected` だけ別枠。
 */
export function resolveInactivityLimitMs(input: { search?: string; state: string }): number {
  const params = new URLSearchParams(input.search ?? '');
  const isConnected = input.state === 'connected';

  // connected 限定の指定が最優先（より具体的な指定が勝つ）。
  if (isConnected) {
    const connectedOverride = positiveMs(params.get('connectedInactivityMs'));
    if (connectedOverride !== undefined) return connectedOverride;
  }

  const uniformOverride = positiveMs(params.get('inactivityMs'));
  if (uniformOverride !== undefined) return uniformOverride;

  return isConnected ? CONNECTED_INACTIVITY_RESET_MS : INACTIVITY_RESET_MS;
}
