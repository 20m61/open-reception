import { describe, it, expect } from 'vitest';
import { TtsSynthesisService } from './synthesis-service';
import { InMemoryTtsCache } from './cache-store';
import type { StreamingTtsProvider, TtsAudioChunk, TtsRequest } from '@/domain/voice-tts/types';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return {
    utteranceId: 'u1',
    locale: 'ja-JP',
    voice: 'Takumi',
    engine: 'neural',
    rate: 1,
    lexiconVersion: 'v1',
    text: { displayText: 'ようこそ' },
    ...overrides,
  };
}

/** テスト用 provider: 呼び出し回数を記録し、常に成功する。 */
class CountingProvider implements StreamingTtsProvider {
  synthesizeCallCount = 0;

  async *synthesize(req: TtsRequest): AsyncIterable<TtsAudioChunk> {
    this.synthesizeCallCount += 1;
    yield { utteranceId: req.utteranceId, seq: 0, audioTimestampMs: 0, byteLength: 100, final: true };
  }
}

/** テスト用 provider: 常に失敗する（Polly 障害シミュレーション, issue #371 AC）。 */
class FailingProvider implements StreamingTtsProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *synthesize(_req: TtsRequest): AsyncIterable<TtsAudioChunk> {
    throw new Error('polly unavailable');
    // eslint-disable-next-line no-unreachable
    yield undefined as never;
  }
}

describe('TtsSynthesisService (issue #371)', () => {
  it('AC: caches a newly generated utterance so the next request with the same key is a cache hit', async () => {
    const provider = new CountingProvider();
    const service = new TtsSynthesisService(provider, new InMemoryTtsCache());
    const r1 = await service.synthesize(request());
    expect(r1.outcome).toBe('generated');
    expect(provider.synthesizeCallCount).toBe(1);

    const r2 = await service.synthesize(request());
    expect(r2.outcome).toBe('cached');
    expect(provider.synthesizeCallCount).toBe(1); // ネットワーク生成なしで再生できる (AC)
  });

  it('AC: a request for a different speechText is not a cache hit', async () => {
    const provider = new CountingProvider();
    const service = new TtsSynthesisService(provider, new InMemoryTtsCache());
    await service.synthesize(request({ text: { displayText: 'ようこそ' } }));
    const r2 = await service.synthesize(request({ utteranceId: 'u2', text: { displayText: '別の案内' } }));
    expect(r2.outcome).toBe('generated');
    expect(provider.synthesizeCallCount).toBe(2);
  });

  it('AC: on provider failure, falls back to a pre-cached canned utterance (fallbackCacheKey), not the failed dynamic text', async () => {
    // 動的文（担当者名等）の合成失敗時、その正確なテキストのキャッシュは原理的に存在しえない
    // （存在すれば冒頭のキャッシュヒットで既に provider を呼ばずに済んでいるため）。フォール
    // バックは事前生成済みの定型文（別キー）へ差し替える設計であることを検証する。
    const cache = new InMemoryTtsCache();
    const cannedFallbackKey = 'canned:guidance.fallback';
    cache.set(cannedFallbackKey, { audioRef: 'canned-fallback-audio', createdAt: 0 });

    const dynamicRequest = request({ text: { displayText: '田中太郎様をお呼びしています' } });
    const failingService = new TtsSynthesisService(new FailingProvider(), cache);
    const result = await failingService.synthesize(dynamicRequest, { fallbackCacheKey: cannedFallbackKey });
    expect(result.outcome).toBe('fallback_cached');
    if (result.outcome === 'fallback_cached') {
      expect(result.audioRef).toBe('canned-fallback-audio');
    }
  });

  it('AC: without a fallbackCacheKey (or when it is not cached), falls back to caption-only', async () => {
    const cache = new InMemoryTtsCache();
    const service = new TtsSynthesisService(new FailingProvider(), cache);
    const result = await service.synthesize(request(), { fallbackCacheKey: 'never-cached' });
    expect(result.outcome).toBe('fallback_caption');
  });

  it('AC: Polly障害時も字幕とキャッシュ音声で受付を継続できる — no cache available falls back to caption-only, not an unrecoverable error', async () => {
    const service = new TtsSynthesisService(new FailingProvider(), new InMemoryTtsCache());
    const result = await service.synthesize(request());
    expect(result.outcome).toBe('fallback_caption');
  });

  it('AC7: emits #365-shaped events in the correct order (request → first_byte → playback_start)', async () => {
    const events: VoiceEvalEvent[] = [];
    let t = 0;
    const service = new TtsSynthesisService(new CountingProvider(), new InMemoryTtsCache(), {
      now: () => t++,
      onEvalEvent: (e) => events.push(e),
    });
    await service.synthesize(request());
    expect(events.map((e) => e.type)).toEqual(['tts.request', 'tts.first_byte', 'tts.playback_start']);
  });

  it('AC7: on failure with no cache, emits an error event with an enumerable code (not the raw exception message)', async () => {
    const events: VoiceEvalEvent[] = [];
    const service = new TtsSynthesisService(new FailingProvider(), new InMemoryTtsCache(), {
      onEvalEvent: (e) => events.push(e),
    });
    await service.synthesize(request());
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.code).toBe('provider_error');
      expect(errorEvent.code).not.toContain('polly unavailable');
    }
  });

  it('a cache hit does not emit tts.first_byte (no provider call happened, so first-byte timing is meaningless)', async () => {
    const events: VoiceEvalEvent[] = [];
    const provider = new CountingProvider();
    const service = new TtsSynthesisService(provider, new InMemoryTtsCache(), { onEvalEvent: (e) => events.push(e) });
    await service.synthesize(request());
    events.length = 0;
    await service.synthesize(request());
    expect(events.map((e) => e.type)).toEqual(['tts.request', 'tts.playback_start']);
  });
});
