/**
 * 定型発話一覧と事前生成ジョブの**定義** (issue #371)。
 *
 * 実際の事前生成（Polly 呼び出し・S3 格納）はこのモジュールでは行わない —— 実 AWS 認証情報・
 * 実配信境界が要るため #65（外部待ち）。ここでは「何を・どのキーで・どの音声設定で」生成すべきか
 * という**ジョブの記述**だけを純データとして組み立てる。
 *
 * キャッシュ境界（S3/CloudFront/Service Worker/IndexedDB）の設計は
 * `docs/adr/0002-voice-tts-cache-boundaries.md` を参照。この increment の実装は
 * `src/lib/voice-tts/cache-store.ts` のメモリ内キャッシュ（`TtsCache` interface, `types.ts`）のみ。
 */
import { buildTtsCacheKey, resolveSpeechText, type TtsEngine, type TtsUtteranceText } from './types';

/**
 * 事前生成対象として定義済みの定型文（意味キー）一覧。
 *
 * `src/lib/voice/voice-store.ts`（#28・#103）の `VoiceSettings.guidanceIdle` 等、テナントごとに
 * 上書き可能な案内文言に対応するキーを中心に定義する。**文言自体はここに持たない**（管理者が
 * 上書きできる真実源は voice-store.ts 側にあり、本モジュールは意味キーの列挙だけを持つ —— 実文言は
 * `buildPregenerationJob` 呼び出し側が voice-store から読み、この一覧と突き合わせる）。
 */
export const CANNED_UTTERANCE_SEMANTIC_KEYS = [
  'guidance.idle',
  'guidance.confirm',
  'guidance.fallback',
  'calling.waiting',
  'calling.notice',
] as const;

export type CannedUtteranceSemanticKey = (typeof CANNED_UTTERANCE_SEMANTIC_KEYS)[number];

/** 事前生成ジョブ 1 件が対象とする発話（呼び出し側が意味キーと実文言を組み合わせて渡す）。 */
export type CannedUtteranceInput = {
  semanticKey: string;
  text: TtsUtteranceText;
};

/** 事前生成ジョブの 1 項目。実生成は行わず、生成に必要な情報だけを持つ純データ。 */
export type TtsPregenerationJobItem = {
  semanticKey: string;
  cacheKey: string;
  locale: string;
  voice: string;
  engine: TtsEngine;
  rate: number;
  lexiconVersion: string;
  speechText: string;
};

export type TtsVoiceConfig = {
  locale: string;
  voice: string;
  engine: TtsEngine;
  rate: number;
  lexiconVersion: string;
};

/**
 * 定型発話一覧 × 音声設定 から事前生成ジョブを組み立てる。副作用なし（実生成は #65）。
 * 表示文/発音文の分離（`resolveSpeechText`）を適用し、キャッシュキーは合成予定の実 provider 呼び出し
 * と同じ `buildTtsCacheKey` で導出する（生成後に同じキーでキャッシュヒットすることを保証する）。
 */
export function buildPregenerationJob(
  utterances: readonly CannedUtteranceInput[],
  voiceConfig: TtsVoiceConfig,
): TtsPregenerationJobItem[] {
  return utterances.map((u) => {
    const speechText = resolveSpeechText(u.text);
    return {
      semanticKey: u.semanticKey,
      cacheKey: buildTtsCacheKey({ ...voiceConfig, speechText }),
      ...voiceConfig,
      speechText,
    };
  });
}
