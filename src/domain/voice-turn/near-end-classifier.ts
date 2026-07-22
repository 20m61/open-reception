/**
 * 近端発話（TTS 再生中の発話）の分類 (issue #372)。
 *
 * ```text
 * BOT_SPEAKING → near-end VAD → TTS duck → 150〜250msの継続を確認
 *   → backchannel / true interruption / noise分類
 * ```
 *
 * **正解ラベルを見ない**（`tests/voice-evaluation/synthetic-provider.ts` の mock とは違い、ここは
 * 実装本体）。使えるのは音響側の特徴（継続時間・エコー尤度）と STT 部分認識テキストだけ。
 *
 * 分類は次の優先順位で決める:
 * 1. エコー尤度が閾値以上 → `echo`（自己音声エコー。#371 の TTS 再生と同時に自分のマイクへ
 *    回り込んだ音を誤って割り込みと判定しないための一次防波堤。実際の相関計算は #65 の実機側
 *    の責務で、ここでは `echoLikelihood` という中立な入力を受け取るだけ）。
 * 2. 強制停止フレーズ / 「AではなくB」型訂正パターンに一致 → `interruption`（継続時間を待たず
 *    即座に停止 —— issue AC「明示的な訂正では速やかに停止する」）。
 * 3. 継続時間が `minSustainedMsForInterruption` 未満 → `pending`（まだ判断材料が無い。
 *    150〜250ms の継続確認中）。
 * 4. 原則継続フレーズに一致し、かつ継続時間が `maxSustainedMsForBackchannel` 以内 → `backchannel`。
 * 5. 継続時間はあるが認識テキストが空/空白（語彙化できない音） → `noise`（環境音）。
 * 6. それ以外（相づちでもなく空でもない、十分継続した発話） → `interruption`
 *    （安全側に倒す。本物の発話内容を止めずに聞き逃すより、止めてユーザーに発話権を戻す方が
 *    受付用途では損失が小さい）。
 */

export type NearEndClassification = 'backchannel' | 'interruption' | 'noise' | 'echo' | 'pending';

/** 強制停止候補（issue #372 本文）。1 件でも一致すれば即座に interruption。 */
export const FORCED_STOP_PHRASES: readonly string[] = [
  '違います',
  'ちょっと待って',
  'ストップ',
  '戻って',
  'もう一度',
  '聞こえません',
];

/** 原則継続候補（issue #372 本文）。相づちとして扱い、単独では停止しない。 */
export const CONTINUATION_PHRASES: readonly string[] = ['はい', 'ええ', 'うん', 'なるほど', 'そうですね'];

/** 「AではなくB」型訂正パターン（issue #372 本文）。 */
const CORRECTION_PATTERN = /ではなく/;

export type NearEndSignal = {
  /** 近端発話の認識テキスト（partial。未認識なら空文字）。 */
  text: string;
  /** onset からの継続時間（ms）。 */
  sustainedMs: number;
  /**
   * 自己音声エコーらしさ（0..1）。#371 の再生中音声との相関等、上流のエコーキャンセラが
   * 提供する想定。未提供（`undefined`）は「エコーではないと断定できない」ではなく
   * 「情報が無い」を意味し、0 として扱う。
   */
  echoLikelihood?: number;
};

export type NearEndClassifierConfig = {
  /** これ未満の継続時間では判定を保留する（BOT_SPEAKING 側の「150〜250msの継続を確認」）。 */
  minSustainedMsForInterruption: number;
  /** 相づちとして扱ってよい継続時間の上限。 */
  maxSustainedMsForBackchannel: number;
  echoLikelihoodThreshold: number;
  forcedStopPhrases: readonly string[];
  continuationPhrases: readonly string[];
};

export const DEFAULT_NEAR_END_CLASSIFIER_CONFIG: NearEndClassifierConfig = {
  minSustainedMsForInterruption: 150,
  maxSustainedMsForBackchannel: 250,
  echoLikelihoodThreshold: 0.6,
  forcedStopPhrases: FORCED_STOP_PHRASES,
  continuationPhrases: CONTINUATION_PHRASES,
};

function matchesAny(text: string, phrases: readonly string[]): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return phrases.some((p) => trimmed.includes(p));
}

function isCorrectionPattern(text: string): boolean {
  return CORRECTION_PATTERN.test(text);
}

/** 近端発話の観測から分類を決める（参照実装。正解ラベルは一切参照しない）。 */
export function classifyNearEnd(
  signal: NearEndSignal,
  config: NearEndClassifierConfig = DEFAULT_NEAR_END_CLASSIFIER_CONFIG,
): NearEndClassification {
  if ((signal.echoLikelihood ?? 0) >= config.echoLikelihoodThreshold) return 'echo';

  if (matchesAny(signal.text, config.forcedStopPhrases) || isCorrectionPattern(signal.text)) return 'interruption';

  if (signal.sustainedMs < config.minSustainedMsForInterruption) return 'pending';

  if (matchesAny(signal.text, config.continuationPhrases) && signal.sustainedMs <= config.maxSustainedMsForBackchannel) {
    return 'backchannel';
  }

  if (signal.text.trim() === '') return 'noise';

  return 'interruption';
}

/** true interruption だけが再生停止を伴う（issue AC「短い相づちだけで頻繁に発話が停止しない」）。 */
export function shouldStopPlayback(classification: NearEndClassification): boolean {
  return classification === 'interruption';
}
