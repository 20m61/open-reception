/**
 * 簡易リップシンク (issue #5 / #31)。
 *
 * Web Speech API（SpeechSynthesis）は音声波形を取得できないため、発話中フラグと経過時間から
 * 口の開き量を時間ベースで合成する。VRM の口形素 `aa`（口を開く viseme）に流し込む。
 * 感情 expression preset（happy/sad 等）とは別チャンネルのため共存できる（#31「競合しない」）。
 *
 * 純関数で定義し単体テスト可能にする。実際の口パク描画の確認は実機 UAT（#65）。
 */

/** 口を開く最大量（VRM expression `aa` の重み 0..1 の上限）。開きすぎない自然な範囲。 */
export const MOUTH_OPEN_MAX = 0.7;

/**
 * 発話中の口の開き量（0..MOUTH_OPEN_MAX）を返す純関数。
 * - speaking=false なら常に 0（口を閉じる）。
 * - speaking 中は 2 つの sine を合成し、谷では口を閉じる（機械的になりすぎない開閉）。
 */
export function mouthOpenValue(elapsedSec: number, speaking: boolean): number {
  if (!speaking) return 0;
  // [-1, 1] の合成波。正の山で口が開き、谷（負）では 0（閉じ）に丸める。
  const wave = (Math.sin(elapsedSec * 13) + Math.sin(elapsedSec * 7.3 + 1.1)) / 2;
  return Math.max(0, wave) * MOUTH_OPEN_MAX;
}
