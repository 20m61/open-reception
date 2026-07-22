/**
 * TTS 合成のオーケストレーション (issue #371)。
 *
 * `StreamingTtsProvider`（provider 側の生成）と `TtsCache`（キャッシュ境界, ADR 0002）を
 * 組み合わせ、キャッシュヒット時はネットワーク生成を一切行わずに再生できることを保証する
 * （issue #371 AC）。Polly 障害時は呼び出し側が指定する代替キャッシュ（`fallbackCacheKey`、
 * 通常は定型文の事前生成成果物）へ、それも無ければ字幕のみへフォールバックする
 * （`@/domain/voice-tts/fallback.ts`）。#365 計測イベントは `@/domain/voice-tts/eval-bridge.ts`
 * 経由でのみ出す。
 */
import { ttsRequestCacheKey, resolveSpeechText, type StreamingTtsProvider, type TtsCache, type TtsRequest } from '@/domain/voice-tts/types';
import { decideTtsFallback, type TtsFailureReason } from '@/domain/voice-tts/fallback';
import {
  ttsRequestEvent,
  ttsFirstByteEvent,
  ttsPlaybackStartEvent,
  ttsErrorEvent,
  type TtsErrorCode,
} from '@/domain/voice-tts/eval-bridge';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';

export type TtsSynthesisResult =
  | { outcome: 'cached'; cacheKey: string; audioRef: string }
  | { outcome: 'generated'; cacheKey: string; chunkCount: number }
  | { outcome: 'fallback_cached'; cacheKey: string; audioRef: string; reason: TtsFailureReason }
  | { outcome: 'fallback_caption'; cacheKey: string; reason: TtsFailureReason };

export type TtsSynthesisServiceDeps = {
  /** テスト用の時計注入。省略時は Date.now()。 */
  now?: () => number;
  onEvalEvent?: (event: VoiceEvalEvent) => void;
};

export type TtsSynthesizeOptions = {
  /**
   * Provider 障害時にキャッシュ音声フォールバックを試みるための**別キー**（issue #371 AC）。
   *
   * 設計注記: `request` 自身の cacheKey での再フォールバックは意味を持たない —— 冒頭の
   * キャッシュ参照で既にヒット確認済みであり、ヒットしていればここへ到達する前に
   * `outcome: 'cached'` で早期 return しているため、同一キーでの再チェックは構造的に
   * 常に miss になる（到達しない分岐を書かないための設計）。
   *
   * 実運用では、動的文（担当者名等）の合成が失敗しても、事前生成済みの**定型文**
   * （例: 「音声のご案内をご利用いただけません」等の汎用案内, `cache.ts` の
   * `CANNED_UTTERANCE_SEMANTIC_KEYS`）へ差し替えて再生する想定。そのキーをここで渡す。
   */
  fallbackCacheKey?: string;
};

/** provider が投げた例外を、#365 が要求する短い列挙コードへ正規化する（生メッセージを渡さない）。 */
function classifyProviderError(): { reason: TtsFailureReason; code: TtsErrorCode } {
  // この increment は provider 側から失敗理由の詳細（timeout/quota 等）を受け取っていないため
  // 既定は provider_error とする。理由の細分化は実 Polly adapter 導入時（#65）に拡張する。
  return { reason: 'provider_error', code: 'provider_error' };
}

export class TtsSynthesisService {
  constructor(
    private readonly provider: StreamingTtsProvider,
    private readonly cache: TtsCache,
    private readonly deps: TtsSynthesisServiceDeps = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emit(event: VoiceEvalEvent): void {
    this.deps.onEvalEvent?.(event);
  }

  async synthesize(request: TtsRequest, options: TtsSynthesizeOptions = {}): Promise<TtsSynthesisResult> {
    const cacheKey = ttsRequestCacheKey(request);
    this.emit(ttsRequestEvent(this.now(), resolveSpeechText(request.text)));

    const cached = this.cache.get(cacheKey);
    if (cached) {
      // キャッシュヒット: provider.synthesize は一切呼ばない（issue #371 AC のネットワーク生成なし再生）。
      this.emit(ttsPlaybackStartEvent(this.now()));
      return { outcome: 'cached', cacheKey, audioRef: cached.audioRef };
    }

    try {
      let chunkCount = 0;
      let firstByteEmitted = false;
      for await (const _chunk of this.provider.synthesize(request)) {
        chunkCount += 1;
        if (!firstByteEmitted) {
          firstByteEmitted = true;
          this.emit(ttsFirstByteEvent(this.now()));
        }
      }
      this.cache.set(cacheKey, { audioRef: `generated:${cacheKey}`, createdAt: this.now() });
      this.emit(ttsPlaybackStartEvent(this.now()));
      return { outcome: 'generated', cacheKey, chunkCount };
    } catch {
      const { reason, code } = classifyProviderError();
      this.emit(ttsErrorEvent(this.now(), code));

      const fallbackKey = options.fallbackCacheKey;
      const fallbackEntry = fallbackKey ? this.cache.get(fallbackKey) : undefined;
      const decision = decideTtsFallback({
        reason,
        cachedAudioAvailable: !!fallbackEntry,
        cacheKey: fallbackKey ?? cacheKey,
      });
      if (decision.action === 'play_cached' && fallbackEntry) {
        return { outcome: 'fallback_cached', cacheKey: fallbackKey!, audioRef: fallbackEntry.audioRef, reason };
      }
      return { outcome: 'fallback_caption', cacheKey, reason };
    }
  }
}
