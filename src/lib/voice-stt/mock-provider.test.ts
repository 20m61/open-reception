import { describe, it, expect } from 'vitest';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import type { FinalTranscript, PartialTranscript } from '@/domain/voice-stt/types';
import { createMockSttProvider } from './mock-provider';

const CONFIG = { locale: 'ja-JP' as const, audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG };

describe('createMockSttProvider', () => {
  it('emits unstable partials as scripted, then a stable partial once the stabilizer confirms', async () => {
    const provider = createMockSttProvider({
      partials: [
        { afterChunk: 1, text: 'た', confidence: 0.4 },
        { afterChunk: 2, text: 'たな', confidence: 0.5 },
        { afterChunk: 3, text: 'たな', confidence: 0.6 },
      ],
      final: { afterChunk: 4, text: 'たなかです', confidence: 0.9 },
    });

    const session = await provider.start(CONFIG);
    const partials: PartialTranscript[] = [];
    session.onPartial((p) => partials.push(p));

    for (let i = 0; i < 3; i += 1) await session.pushAudio(new ArrayBuffer(1));

    // 3 件の raw partial + 1 件の stable partial（'たな' が window=2 で確定）。
    const unstable = partials.filter((p) => !p.stable);
    const stable = partials.filter((p) => p.stable);
    expect(unstable.map((p) => p.text)).toEqual(['た', 'たな', 'たな']);
    expect(stable).toHaveLength(1);
    expect(stable[0]!.text).toBe('たな');
  });

  it('emits the final transcript via onFinal with matching text/confidence/t', async () => {
    const provider = createMockSttProvider({
      partials: [{ afterChunk: 1, text: 'たなか', confidence: 0.6 }],
      final: { afterChunk: 2, text: 'たなかです', confidence: 0.9 },
    });
    const session = await provider.start(CONFIG);
    const finals: FinalTranscript[] = [];
    session.onFinal((f) => finals.push(f));

    await session.pushAudio(new ArrayBuffer(1));
    await session.pushAudio(new ArrayBuffer(1));

    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('たなかです');
    expect(finals[0]!.confidence).toBe(0.9);
    expect(finals[0]!.t).toBe(2 * DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG.chunkMs);
  });

  it('stops emitting after close(), and close() is idempotent', async () => {
    const provider = createMockSttProvider({
      partials: [
        { afterChunk: 1, text: 'た', confidence: 0.4 },
        { afterChunk: 2, text: 'たな', confidence: 0.5 },
      ],
      final: { afterChunk: 3, text: 'たなです', confidence: 0.8 },
    });
    const session = await provider.start(CONFIG);
    const partials: PartialTranscript[] = [];
    session.onPartial((p) => partials.push(p));

    await session.pushAudio(new ArrayBuffer(1));
    await session.close();
    await session.close(); // idempotent — 二重 close で例外にならない
    await session.pushAudio(new ArrayBuffer(1)); // close 後は no-op

    expect(partials).toHaveLength(1);
  });

  it('supports multiple listeners registered via onPartial/onFinal', async () => {
    const provider = createMockSttProvider({
      partials: [{ afterChunk: 1, text: 'さとう', confidence: 0.5 }],
      final: { afterChunk: 2, text: 'さとうさんです', confidence: 0.9 },
    });
    const session = await provider.start(CONFIG);
    let count1 = 0;
    let count2 = 0;
    session.onPartial(() => (count1 += 1));
    session.onPartial(() => (count2 += 1));

    await session.pushAudio(new ArrayBuffer(1));

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});
