/**
 * TTS → VRM viseme/speaking の中立イベント (issue #371)。
 *
 * スコープ注記（issue #371 運用制約）: VRM 連携はここで定義する**中立イベント形の提供まで**。
 * 現行 VRM viewer（`src/components/kiosk/VrmAvatarViewer.tsx`, このモジュールは触らない）の
 * 実際の接続点は per-viseme blendshape ではなく、`speaking: boolean` prop と
 * `mouthOpenValue(elapsedSec, speaking)`（`src/components/kiosk/avatar/lip-sync.ts`）による
 * 疑似アニメーションである。本モジュールは Speech Marks（Polly）または音量解析のどちらから
 * 来ても同じ形の viseme タイムラインへ正規化し、viewer への実配線（per-viseme blendshape 化、
 * または `mouthOpenHint` を `mouthOpenValue` の代替として使う単純化）は次周回で行う。
 */
import { isSpeakingMotionActive, type TtsPlaybackState } from './lifecycle';

/**
 * Polly Speech Marks の viseme 語彙（English/Japanese 共通の音素グループ）。
 * 未知の値は 'sil' にフォールバックする（`toTtsVisemeId` 参照）。
 */
export const TTS_VISEME_IDS = ['sil', 'p', 't', 'S', 'T', 'f', 'k', 'i', 'r', 's', 'u', '@', 'a', 'e', 'E', 'o'] as const;
export type TtsVisemeId = (typeof TTS_VISEME_IDS)[number];

/** viseme ごとの目安口開き量（0..1）。母音は開き量が大きく、破裂音/摩擦音は小さい。 */
const VISEME_MOUTH_OPEN_HINT: Record<TtsVisemeId, number> = {
  sil: 0,
  p: 0.15,
  t: 0.2,
  S: 0.25,
  T: 0.2,
  f: 0.2,
  k: 0.2,
  i: 0.4,
  r: 0.3,
  s: 0.2,
  u: 0.5,
  '@': 0.5,
  a: 0.9,
  e: 0.6,
  E: 0.6,
  o: 0.7,
};

function toTtsVisemeId(value: string): TtsVisemeId {
  return (TTS_VISEME_IDS as readonly string[]).includes(value) ? (value as TtsVisemeId) : 'sil';
}

/** Polly Speech Marks の 1 行（viseme/word/sentence のいずれか）。 */
export type TtsSpeechMark = {
  /** utterance 音声内の相対 ms（Polly の `time` フィールドに相当）。 */
  timeMs: number;
  type: 'viseme' | 'word' | 'sentence';
  value: string;
};

/** 中立形の viseme イベント。#365 の `vrm.viseme_applied.audioTimestampMs` と同じ単位・起点。 */
export type TtsVisemeEvent = {
  utteranceId: string;
  audioTimestampMs: number;
  viseme: TtsVisemeId;
  /**
   * 目安口開き量（0..1）。現行 viewer が `mouthOpenValue` の代わりに直接使ってもよい単純化された
   * 振幅ヒント（配線は次周回）。
   */
  mouthOpenHint: number;
};

/** Speech Marks から viseme タイムラインを導出する（`type !== 'viseme'` は無視）。 */
export function visemeTimelineFromSpeechMarks(utteranceId: string, marks: readonly TtsSpeechMark[]): TtsVisemeEvent[] {
  return marks
    .filter((m) => m.type === 'viseme')
    .map((m) => {
      const viseme = toTtsVisemeId(m.value);
      return {
        utteranceId,
        audioTimestampMs: m.timeMs,
        viseme,
        mouthOpenHint: VISEME_MOUTH_OPEN_HINT[viseme],
      };
    });
}

/** 音量サンプル 1 点。Speech Marks が使えない provider（フォールバック等）向けの代替入力。 */
export type TtsAmplitudeSample = {
  tMs: number;
  /** 0..1 の正規化振幅（クランプ前）。 */
  amplitude: number;
};

const AMPLITUDE_SIL_THRESHOLD = 0.1;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 音量解析から viseme タイムラインを導出する。しきい値未満は `sil`、以上は開き量に応じた
 * 母音 viseme（`a`）へ丸める簡易モデル（音素までは判別しない —— provider が Speech Marks を
 * 出さない場合の低精度フォールバック）。
 */
export function visemeTimelineFromAmplitude(utteranceId: string, samples: readonly TtsAmplitudeSample[]): TtsVisemeEvent[] {
  return samples.map((s) => {
    const amplitude = clamp01(s.amplitude);
    const viseme: TtsVisemeId = amplitude >= AMPLITUDE_SIL_THRESHOLD ? 'a' : 'sil';
    return {
      utteranceId,
      audioTimestampMs: s.tMs,
      viseme,
      mouthOpenHint: viseme === 'sil' ? 0 : amplitude,
    };
  });
}

/**
 * 再生停止時に必ず発行する「口を閉じる」イベント (issue #371 AC: 停止時に口パクが残らない)。
 * `stopPlayback`/`discardQueuedAudio`/生成中止のいずれの経路でも、このイベントを最後に一度
 * 出すことで、viseme タイムラインが途中で終わって口が開いたまま止まることを防ぐ。
 */
export function visemeStopEvent(utteranceId: string, atMs: number): TtsVisemeEvent {
  return { utteranceId, audioTimestampMs: atMs, viseme: 'sil', mouthOpenHint: 0 };
}

/** 中立形の speaking タイムラインイベント。現行 viewer の `speaking` prop の配線点。 */
export type TtsSpeakingTimelineEvent = {
  utteranceId: string;
  speaking: boolean;
  /** セッション開始からの相対 ms（評価ハーネスと同じ単一時計源を想定）。 */
  t: number;
};

/** playbackState から speaking タイムラインイベントを導出する（`isSpeakingMotionActive` を使う）。 */
export function speakingTimelineEvent(utteranceId: string, playbackState: TtsPlaybackState, t: number): TtsSpeakingTimelineEvent {
  return { utteranceId, speaking: isSpeakingMotionActive(playbackState), t };
}
