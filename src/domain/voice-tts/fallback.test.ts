import { describe, it, expect } from 'vitest';
import { decideTtsFallback, TTS_FAILURE_REASONS } from './fallback';

describe('decideTtsFallback (issue #371 AC: Polly 障害時も字幕とキャッシュ音声で受付を継続できる)', () => {
  it('plays cached audio when a cache entry exists for the same key', () => {
    const decision = decideTtsFallback({ reason: 'provider_error', cachedAudioAvailable: true, cacheKey: 'k1' });
    expect(decision).toEqual({ action: 'play_cached', cacheKey: 'k1' });
  });

  it('falls back to caption-only when no cache entry is available', () => {
    const decision = decideTtsFallback({ reason: 'provider_error', cachedAudioAvailable: false, cacheKey: 'k1' });
    expect(decision).toEqual({ action: 'caption_only' });
  });

  it('never returns an outcome that halts reception — every reason resolves to a continuable action', () => {
    for (const reason of TTS_FAILURE_REASONS) {
      const withCache = decideTtsFallback({ reason, cachedAudioAvailable: true, cacheKey: 'k' });
      const withoutCache = decideTtsFallback({ reason, cachedAudioAvailable: false, cacheKey: 'k' });
      expect(['play_cached', 'caption_only']).toContain(withCache.action);
      expect(['play_cached', 'caption_only']).toContain(withoutCache.action);
    }
  });

  it('caption_only never carries a stale cacheKey — the caller must always show text regardless', () => {
    const decision = decideTtsFallback({ reason: 'timeout', cachedAudioAvailable: false, cacheKey: 'k1' });
    expect(decision).not.toHaveProperty('cacheKey');
  });
});
