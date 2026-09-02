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
 *   - `?inactivityMs=`            … 全状態に一律（既存の流儀）
 *   - `?inactivityMs.<state>=`    … その状態のみ（例 `?inactivityMs.connected=600`）
 *
 * 状態限定の口が要るのは、一律短縮だと**検証したい状態へ至るまでの操作すべて**が同じ短い
 * 上限に晒されるため。警告表示までの猶予は `limit - warnMs` で、`warnMs` が
 * `min(INACTIVITY_WARNING_MS, limit - 500)` に丸められる結果、**limit が 10.5 秒未満なら
 * 猶予は常に 500ms 固定**になる。つまり `?inactivityMs=` の値を大きくしても解決しない。
 * 1 ステップでもアニメーション待ち等で 500ms を超えると警告オーバーレイが click を
 * 横取りしてテストが落ちる（負荷依存のフレーク）。
 *
 * 「そこへ至るまでは本番既定・検証したい状態だけ短縮」を表現できるようにして、競合を
 * 構造的に消す。
 */

import { shouldResetOnInactivity, type ReceptionState } from '../reception/state';
import type { CheckinState } from '../checkin/state';

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

  // 状態限定の指定が最優先（より具体的な指定が勝つ）。
  const scopedOverride = positiveMs(params.get(`inactivityMs.${input.state}`));
  if (scopedOverride !== undefined) return scopedOverride;

  const uniformOverride = positiveMs(params.get('inactivityMs'));
  if (uniformOverride !== undefined) return uniformOverride;

  return input.state === 'connected' ? CONNECTED_INACTIVITY_RESET_MS : INACTIVITY_RESET_MS;
}

/**
 * 無操作リセットを働かせるべきか（キオスク全体で見た判定, #871）。
 *
 * `shouldResetOnInactivity(state)` は `ReceptionState` だけを見る。しかし **QR 受付は受付
 * 状態機械を進めない** —— `KioskFlow` は `setMode('checkin')` を呼ぶだけで `ReceptionState`
 * は `idle` のまま残り、`idle` は `INACTIVITY_RESET_STATES` に含まれない。結果、QR 受付では
 * 無操作リセットが一度も発火せず、予約内容の確認画面（氏名・会社名・予約時刻）が
 * ロビーの端末に無期限で残っていた。通常受付では #125 で解決済みの問題が、QR 経路にだけ
 * 残っていた形である。
 *
 * ここで合成することで、「どの画面層に居るか」を知っている呼び出し側（`KioskFlow`）が
 * 判断を持ち込まずに済む。**入力手段が増えても、この関数に足せば全経路へ効く。**
 */
export function shouldResetOnInactivityForKiosk(input: {
  /** 受付状態機械の現在状態。 */
  readonly receptionState: ReceptionState;
  /** QR 受付（`KioskMode.checkin`）が動いているか。 */
  readonly qrCheckinActive: boolean;
}): boolean {
  return input.qrCheckinActive || shouldResetOnInactivity(input.receptionState);
}

/**
 * 終端状態（完了・中止）から待機画面へ自動復帰するまでの時間 (#125 / #871)。
 *
 * 通常受付の `KioskFlow` が使っていた値をここへ移し、QR 受付と**同じ値を共有する**。
 * 別々に持つと、片方だけ調整されて「同じ完了画面なのに入口によって待たされ方が違う」
 * が静かに生まれる。
 */
export const TERMINAL_AUTO_RESET_MS = 6000;

/**
 * QR 受付の状態が「終端」か —— 待機画面へ自動復帰させるべきか (#871)。
 *
 * 通常受付は `completed` / `cancelled` から `TERMINAL_AUTO_RESET_MS` で戻るが、QR 受付には
 * この短い復帰が無く、無操作リセット（既定 60 秒）を待つしかなかった。「受付が完了しました」
 * の画面が 1 分間居座ると、次の来訪者は端末が壊れていると読む。
 *
 * **進行中の状態を含めない。** 読み取り中や確認中に勝手に戻すと、来訪者の操作を奪う
 * （そちらは無操作リセットの担当で、警告カウントダウンと「続ける」を伴う）。
 */
export function shouldAutoReturnFromCheckin(state: CheckinState): boolean {
  return state === 'completed' || state === 'cancelled';
}
