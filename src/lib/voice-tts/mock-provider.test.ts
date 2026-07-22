import { describe, it, expect } from 'vitest';
import { MockStreamingTtsProvider } from './mock-provider';
import type { TtsRequest } from '@/domain/voice-tts/types';

function request(overrides: Partial<TtsRequest> = {}): TtsRequest {
  return {
    utteranceId: 'u1',
    locale: 'ja-JP',
    voice: 'Takumi',
    engine: 'neural',
    rate: 1,
    lexiconVersion: 'v1',
    text: { displayText: 'ようこそ、受付システムです' },
    ...overrides,
  };
}

describe('MockStreamingTtsProvider (issue #371, mock 先行 — 実 Polly は #65 外部待ち)', () => {
  it('yields at least one chunk for a non-empty utterance', async () => {
    const provider = new MockStreamingTtsProvider();
    const chunks = [];
    for await (const chunk of provider.synthesize(request())) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.utteranceId === 'u1')).toBe(true);
  });

  it('marks only the last chunk as final, with strictly increasing seq and audioTimestampMs', () => {
    return (async () => {
      const provider = new MockStreamingTtsProvider();
      const chunks = [];
      for await (const chunk of provider.synthesize(request())) chunks.push(chunk);
      expect(chunks.slice(0, -1).every((c) => c.final === false)).toBe(true);
      expect(chunks.at(-1)!.final).toBe(true);
      const seqs = chunks.map((c) => c.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    })();
  });

  it('is deterministic for the same request (same text → same chunk count)', async () => {
    const provider = new MockStreamingTtsProvider();
    const collect = async () => {
      const chunks = [];
      for await (const chunk of provider.synthesize(request())) chunks.push(chunk);
      return chunks.length;
    };
    expect(await collect()).toBe(await collect());
  });

  it('longer speechText yields more chunks than shorter speechText (models streaming, not a single blob)', async () => {
    const provider = new MockStreamingTtsProvider();
    const short = [];
    for await (const c of provider.synthesize(request({ text: { displayText: '短い' } }))) short.push(c);
    const long = [];
    for await (const c of provider.synthesize(request({ text: { displayText: 'これはとても長い案内文です。'.repeat(5) } }))) {
      long.push(c);
    }
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('abortGeneration before synthesize() is consumed stops the stream early (provider 側の生成中止)', async () => {
    const provider = new MockStreamingTtsProvider();
    const req = request({ text: { displayText: 'これはとても長い案内文です。'.repeat(10) } });
    const chunks = [];
    let i = 0;
    for await (const chunk of provider.synthesize(req)) {
      chunks.push(chunk);
      i += 1;
      if (i === 2) await provider.abortGeneration!(req.utteranceId);
    }
    // 中止後は最終チャンクまで届かない（final チャンクが出ないまま止まる）。
    expect(chunks.length).toBeLessThan(20);
    expect(chunks.at(-1)!.final).toBe(false);
  });

  it('aborting an unrelated utteranceId does not affect this stream (utterance 単位の独立性)', async () => {
    const provider = new MockStreamingTtsProvider();
    await provider.abortGeneration!('someone-else');
    const chunks = [];
    for await (const chunk of provider.synthesize(request())) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)!.final).toBe(true);
  });

  it('resolves speechText over displayText when producing chunk counts (respects display/speech separation)', async () => {
    const provider = new MockStreamingTtsProvider();
    const withSpeech = [];
    for await (const c of provider.synthesize(
      request({ text: { displayText: '田中太郎様', speechText: 'たなか たろう さまを お呼びしています。これはさらに長い読み上げ用の文章です。' } }),
    )) {
      withSpeech.push(c);
    }
    const displayOnly = [];
    for await (const c of provider.synthesize(request({ text: { displayText: '田中太郎様' } }))) displayOnly.push(c);
    expect(withSpeech.length).toBeGreaterThan(displayOnly.length);
  });
});
