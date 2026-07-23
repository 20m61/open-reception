/**
 * 再生済みテキスト地点の追跡と会話履歴の切り詰め (issue #372)。
 *
 * barge-in で TTS を止めたとき、応答テキスト全文を会話履歴に残すと「言っていないことを言った」
 * ことになる。実際に再生済みの地点までで切り詰める（issue #372 実装タスク「再生済みテキスト
 * 地点を追跡し、会話履歴を切り詰める」）。
 *
 * 簡易モデル: viseme/Speech Marks 単位の精密な文字境界は #371 側（`vrm.viseme_applied`）が
 * 持つが、ここでは経過時間 ÷ 全体再生時間の比率でテキスト長を按分する近似を使う
 * （文字ごとの発声時間はほぼ均一という前提。読点・数字読み上げ等で誤差は出るが、履歴表示用の
 * 近似としては十分。精密化は #65 の実機データで補正する）。
 */

/**
 * 再生開始から停止までの経過時間 ÷ 全体再生時間の比率で、実際に発声された文字数を見積もり、
 * その分だけ全文を切り詰める。
 *
 * - `totalDurationMs` が 0 以下（計測できない）なら空文字を返す（分母 0 を全文再生扱いにしない）。
 * - 停止が再生開始より前、または経過が 0 以下なら空文字。
 * - 経過が全体時間以上なら全文（= 最後まで再生できていた）。
 */
export function estimateSpokenText(fullText: string, playbackStartMs: number, stopMs: number, totalDurationMs: number): string {
  if (totalDurationMs <= 0) return '';
  const elapsedMs = stopMs - playbackStartMs;
  if (elapsedMs <= 0) return '';
  const ratio = Math.min(1, elapsedMs / totalDurationMs);
  const chars = [...fullText];
  const cutIndex = Math.round(chars.length * ratio);
  return chars.slice(0, cutIndex).join('');
}

export type ConversationTurnRecord = {
  turnIndex: number;
  role: 'assistant';
  text: string;
};

export type PlaybackTruncation = {
  turnIndex: number;
  spokenText: string;
};

/**
 * 会話履歴のうち、割り込みで打ち切られたターンだけを実際に再生された地点のテキストへ差し替える。
 * 該当しないターンはそのまま。**新しい配列を返す**（呼び出し側の履歴を直接書き換えない）。
 */
export function truncateConversationHistory(
  history: readonly ConversationTurnRecord[],
  truncation: PlaybackTruncation,
): ConversationTurnRecord[] {
  return history.map((turn) => (turn.turnIndex === truncation.turnIndex ? { ...turn, text: truncation.spokenText } : turn));
}
