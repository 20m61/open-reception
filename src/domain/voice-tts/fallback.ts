/**
 * Polly（provider）障害時のフォールバック判定 (issue #371 AC: 障害時も字幕とキャッシュ音声で
 * 受付を継続できる)。
 *
 * `src/domain/voice-transport/fallback.ts`（#369, タッチ受付への切替）とは対象が異なる ——
 * こちらは TTS 1 発話単位のフォールバックで、常に「継続可能」な結果を返す（caption_only は
 * 常に選べる最終防御線であり、受付を止める outcome を持たない）。
 */
export const TTS_FAILURE_REASONS = ['provider_error', 'network_error', 'timeout', 'quota_exceeded'] as const;
export type TtsFailureReason = (typeof TTS_FAILURE_REASONS)[number];

export type TtsFallbackDecision = { action: 'play_cached'; cacheKey: string } | { action: 'caption_only' };

export type TtsFallbackInput = {
  reason: TtsFailureReason;
  /** 同一キャッシュキーの音声が既にキャッシュ済みか（過去の生成成功 or 事前生成ジョブの成果物）。 */
  cachedAudioAvailable: boolean;
  cacheKey: string;
};

/**
 * キャッシュ済み音声があればそれを再生し、無ければ字幕のみ（displayText 表示は常に可能なので、
 * このケースだけを理由に受付を止めることはない）。
 */
export function decideTtsFallback(input: TtsFallbackInput): TtsFallbackDecision {
  if (input.cachedAudioAvailable) {
    return { action: 'play_cached', cacheKey: input.cacheKey };
  }
  return { action: 'caption_only' };
}
