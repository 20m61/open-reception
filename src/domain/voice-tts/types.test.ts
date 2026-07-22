import { describe, it, expect } from 'vitest';
import { buildTtsCacheKey, resolveSpeechText, ttsRequestCacheKey, type TtsRequest } from './types';

describe('buildTtsCacheKey', () => {
  it('combines locale + voice + engine + rate + speechText + lexiconVersion (issue #371 契約)', () => {
    const key = buildTtsCacheKey({
      locale: 'ja-JP',
      voice: 'Takumi',
      engine: 'neural',
      rate: 1,
      speechText: 'ようこそ',
      lexiconVersion: 'v1',
    });
    expect(key).toContain('ja-JP');
    expect(key).toContain('Takumi');
    expect(key).toContain('neural');
    expect(key).toContain('ようこそ');
    expect(key).toContain('v1');
  });

  it('is stable for identical parts (referential determinism, cache hit requires this)', () => {
    const parts = {
      locale: 'ja-JP',
      voice: 'Takumi',
      engine: 'neural' as const,
      rate: 1,
      speechText: 'ようこそ',
      lexiconVersion: 'v1',
    };
    expect(buildTtsCacheKey(parts)).toBe(buildTtsCacheKey({ ...parts }));
  });

  it('does not collide when field boundaries shift but concatenation would look identical', () => {
    // 'ja' + '-JP' な locale/voice の連結 vs 'ja-JP' + '' のような取り違えを、
    // 長さプレフィックスで構造的に防げていることを確認する。
    const a = buildTtsCacheKey({
      locale: 'ja',
      voice: '-JPTakumi',
      engine: 'neural',
      rate: 1,
      speechText: 'x',
      lexiconVersion: 'v1',
    });
    const b = buildTtsCacheKey({
      locale: 'ja-JP',
      voice: 'Takumi',
      engine: 'neural',
      rate: 1,
      speechText: 'x',
      lexiconVersion: 'v1',
    });
    expect(a).not.toBe(b);
  });

  it('differs when rate differs (rate is part of the cache key contract)', () => {
    const base = { locale: 'ja-JP', voice: 'Takumi', engine: 'neural' as const, speechText: 'x', lexiconVersion: 'v1' };
    expect(buildTtsCacheKey({ ...base, rate: 1 })).not.toBe(buildTtsCacheKey({ ...base, rate: 1.2 }));
  });

  it('differs when lexiconVersion differs (lexicon changes must invalidate cache)', () => {
    const base = { locale: 'ja-JP', voice: 'Takumi', engine: 'neural' as const, rate: 1, speechText: 'x' };
    expect(buildTtsCacheKey({ ...base, lexiconVersion: 'v1' })).not.toBe(
      buildTtsCacheKey({ ...base, lexiconVersion: 'v2' }),
    );
  });
});

describe('resolveSpeechText (display text / speech text separation, issue #371 AC)', () => {
  it('uses speechText when provided (pronunciation differs from display, e.g. name readings)', () => {
    expect(resolveSpeechText({ displayText: '田中太郎', speechText: 'たなか たろう' })).toBe('たなか たろう');
  });

  it('falls back to displayText when speechText is absent', () => {
    expect(resolveSpeechText({ displayText: 'ようこそ' })).toBe('ようこそ');
  });

  it('falls back to displayText when speechText is blank/whitespace-only', () => {
    expect(resolveSpeechText({ displayText: 'ようこそ', speechText: '   ' })).toBe('ようこそ');
  });
});

describe('ttsRequestCacheKey', () => {
  it('derives the cache key from a TtsRequest using the resolved speech text (not display text)', () => {
    const request: TtsRequest = {
      utteranceId: 'u1',
      locale: 'ja-JP',
      voice: 'Takumi',
      engine: 'neural',
      rate: 1,
      lexiconVersion: 'v1',
      text: { displayText: '田中太郎様をお呼びしています', speechText: 'たなか たろう さまを お呼びしています' },
    };
    const key = ttsRequestCacheKey(request);
    expect(key).toContain('たなか たろう さまを お呼びしています');
    expect(key).not.toContain('田中太郎様');
  });

  it('two requests with identical resolved fields produce the same cache key regardless of utteranceId', () => {
    const base: Omit<TtsRequest, 'utteranceId'> = {
      locale: 'ja-JP',
      voice: 'Takumi',
      engine: 'neural',
      rate: 1,
      lexiconVersion: 'v1',
      text: { displayText: 'ようこそ' },
    };
    const key1 = ttsRequestCacheKey({ ...base, utteranceId: 'u1' });
    const key2 = ttsRequestCacheKey({ ...base, utteranceId: 'u2' });
    expect(key1).toBe(key2);
  });
});
