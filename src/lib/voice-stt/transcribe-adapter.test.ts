import { describe, it, expect } from 'vitest';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import type { FinalTranscript, PartialTranscript } from '@/domain/voice-stt/types';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import type { VoiceSttFallbackEvent } from '@/domain/voice-stt/fallback';
import { TranscribeStreamingSttProvider, type TranscribeConnection } from './transcribe-adapter';
import type { TranscribeTranscriptEvent } from './transcribe-protocol';

const CONFIG = { locale: 'ja-JP' as const, audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG };

/** テスト用 mock connection。実 WSS/SigV4 は持たない（#65）。 */
function createMockConnection() {
  let eventHandler: ((e: TranscribeTranscriptEvent) => void) | null = null;
  let errorHandler: ((code: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const sent: ArrayBuffer[] = [];
  const closeCalls: number[] = [];

  const connection: TranscribeConnection = {
    send: (chunk) => sent.push(chunk),
    onEvent: (handler) => {
      eventHandler = handler;
    },
    onError: (handler) => {
      errorHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    close: () => closeCalls.push(1),
  };

  return {
    connection,
    sent,
    closeCalls,
    emitEvent: (e: TranscribeTranscriptEvent) => eventHandler?.(e),
    emitError: (code: string) => errorHandler?.(code),
    emitClose: () => closeHandler?.(),
  };
}

function partialEvent(text: string, stable: boolean): TranscribeTranscriptEvent {
  return {
    Transcript: {
      Results: [
        {
          ResultId: 'r1',
          IsPartial: true,
          Alternatives: [{ Transcript: text, Items: [{ Content: text, Confidence: 0.8, Stable: stable }] }],
        },
      ],
    },
  };
}

function finalEvent(text: string): TranscribeTranscriptEvent {
  return {
    Transcript: {
      Results: [
        {
          ResultId: 'r2',
          IsPartial: false,
          Alternatives: [{ Transcript: text, Items: [{ Content: text, Confidence: 0.9 }] }],
        },
      ],
    },
  };
}

describe('TranscribeStreamingSttProvider', () => {
  it('forwards pushAudio bytes to the underlying connection', async () => {
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection);
    const session = await provider.start(CONFIG);

    const chunk = new ArrayBuffer(4);
    await session.pushAudio(chunk);

    expect(mock.sent).toEqual([chunk]);
  });

  it('maps connection events into onPartial/onFinal callbacks', async () => {
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection);
    const session = await provider.start(CONFIG);

    const partials: PartialTranscript[] = [];
    const finals: FinalTranscript[] = [];
    session.onPartial((p) => partials.push(p));
    session.onFinal((f) => finals.push(f));

    mock.emitEvent(partialEvent('たなか', false));
    mock.emitEvent(partialEvent('たなか', true));
    mock.emitEvent(finalEvent('たなかです'));

    expect(partials.map((p) => [p.text, p.stable])).toEqual([
      ['たなか', false],
      ['たなか', true],
    ]);
    expect(finals.map((f) => f.text)).toEqual(['たなかです']);
  });

  it('closes the underlying connection exactly once even if close() is called twice', async () => {
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection);
    const session = await provider.start(CONFIG);

    await session.close();
    await session.close();

    expect(mock.closeCalls).toHaveLength(1);
  });

  it('surfaces connection errors as a stt eval-bridge error event and a fallback event', async () => {
    const evalEvents: VoiceEvalEvent[] = [];
    const fallbacks: VoiceSttFallbackEvent[] = [];
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection, {
      onEvalEvent: (e) => evalEvents.push(e),
      onFallback: (f) => fallbacks.push(f),
    });
    await provider.start(CONFIG);

    mock.emitError('stream_error');

    expect(evalEvents).toContainEqual(expect.objectContaining({ type: 'error', stage: 'stt', code: 'stream_error' }));
    expect(fallbacks).toContainEqual(expect.objectContaining({ type: 'voiceSttFallbackRequired', reason: 'stream_error' }));
  });

  it('surfaces an unexpected connection close as session.aborted + fallback, without double-firing after explicit close', async () => {
    const evalEvents: VoiceEvalEvent[] = [];
    const fallbacks: VoiceSttFallbackEvent[] = [];
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection, {
      onEvalEvent: (e) => evalEvents.push(e),
      onFallback: (f) => fallbacks.push(f),
    });
    const session = await provider.start(CONFIG);

    mock.emitClose();
    expect(evalEvents).toContainEqual(expect.objectContaining({ type: 'session.aborted', stage: 'stt' }));
    expect(fallbacks).toContainEqual(expect.objectContaining({ reason: 'provider_unavailable' }));

    const fallbackCountAfterUnexpectedClose = fallbacks.length;
    await session.close();
    mock.emitClose(); // 遅延到着した close コールバックは無視される
    expect(fallbacks).toHaveLength(fallbackCountAfterUnexpectedClose);
  });

  it('ignores pushAudio after close() (no-op, no throw)', async () => {
    const mock = createMockConnection();
    const provider = new TranscribeStreamingSttProvider(() => mock.connection);
    const session = await provider.start(CONFIG);
    await session.close();

    await expect(session.pushAudio(new ArrayBuffer(1))).resolves.toBeUndefined();
    expect(mock.sent).toHaveLength(0);
  });
});
