/**
 * `StreamingSttProvider` の Amazon Transcribe Streaming adapter — 接続プロトコル境界まで
 * (issue #370)。
 *
 * 実 WSS 接続の確立・SigV4 署名・実際の AWS 認証情報は本 increment のスコープ外（#65 — 実
 * AWS 認証情報が要る）。この adapter は `TranscribeConnection`（接続の境界 interface）を
 * `TranscribeConnectionFactory` から受け取るだけで、接続そのものは作らない。実装時は
 * このファクトリの実体だけを #65 で差し替えればよく、イベント写像・session lifecycle・
 * フォールバック配線はここで先行してテスト済みにしておく。
 *
 * close() の唯一性: `src/lib/voice-transport/client.ts` の `terminate()` と同じ方針で、
 * `closed` フラグを同期的に立ててから片付けるため、二重 close や close 後に遅延到着した
 * `onClose` コールバックでも副作用が二重に走らない。
 */
import { fallbackEventForSttError, fallbackEventForSttStatus, type VoiceSttFallbackEvent } from '@/domain/voice-stt/fallback';
import type { FinalTranscript, PartialTranscript, SttSession, SttSessionConfig, StreamingSttProvider } from '@/domain/voice-stt/types';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import { sttErrorEvent, sttFinalEvent, sttPartialEvent, sttSessionAbortedEvent, VOICE_STT_ERROR_CODES, type VoiceSttErrorCode } from '@/domain/voice-stt/eval-bridge';
import { mapTranscribeEventToFinal, mapTranscribeEventToPartial, type TranscribeTranscriptEvent } from './transcribe-protocol';

/**
 * Transcribe Streaming への接続の境界 interface。実装（WSS + SigV4）は #65。
 * テストでは mock connection を注入して adapter のロジックだけを検証する。
 */
export type TranscribeConnection = {
  send(chunk: ArrayBuffer): void;
  onEvent(handler: (event: TranscribeTranscriptEvent) => void): void;
  onError(handler: (code: string) => void): void;
  /** 明示 close 以外での切断（サーバ切断・ネットワーク断）を通知する。 */
  onClose(handler: () => void): void;
  close(): void;
};

export type TranscribeConnectionFactory = (config: SttSessionConfig) => TranscribeConnection;

export type TranscribeAdapterCallbacks = {
  onFallback?: (event: VoiceSttFallbackEvent) => void;
  onEvalEvent?: (event: VoiceEvalEvent) => void;
};

function isKnownSttErrorCode(code: string): code is VoiceSttErrorCode {
  return (VOICE_STT_ERROR_CODES as readonly string[]).includes(code);
}

export class TranscribeStreamingSttProvider implements StreamingSttProvider {
  constructor(
    private readonly connectionFactory: TranscribeConnectionFactory,
    private readonly callbacks: TranscribeAdapterCallbacks = {},
  ) {}

  async start(config: SttSessionConfig): Promise<SttSession> {
    const startedAtMs = Date.now();
    const connection = this.connectionFactory(config);
    const partialListeners: Array<(result: PartialTranscript) => void> = [];
    const finalListeners: Array<(result: FinalTranscript) => void> = [];
    let closed = false;

    const tMs = () => Date.now() - startedAtMs;

    connection.onEvent((event) => {
      if (closed) return;
      const partial = mapTranscribeEventToPartial(event, tMs());
      if (partial) {
        this.callbacks.onEvalEvent?.(sttPartialEvent(partial));
        partialListeners.forEach((listener) => listener(partial));
      }
      const final = mapTranscribeEventToFinal(event, tMs());
      if (final) {
        this.callbacks.onEvalEvent?.(sttFinalEvent(final));
        finalListeners.forEach((listener) => listener(final));
      }
    });

    connection.onError((code) => {
      if (closed) return;
      const sttCode: VoiceSttErrorCode = isKnownSttErrorCode(code) ? code : 'stream_error';
      this.callbacks.onEvalEvent?.(sttErrorEvent(tMs(), sttCode));
      this.callbacks.onFallback?.(fallbackEventForSttError(sttCode, tMs()));
    });

    connection.onClose(() => {
      if (closed) return; // 明示 close 済みなら、遅延到着した close コールバックは無視する。
      closed = true;
      this.callbacks.onEvalEvent?.(sttSessionAbortedEvent(tMs(), 'provider_unavailable'));
      const fallback = fallbackEventForSttStatus('closed_unexpectedly', tMs());
      if (fallback) this.callbacks.onFallback?.(fallback);
    });

    return {
      pushAudio: async (chunk: ArrayBuffer) => {
        if (closed) return;
        connection.send(chunk);
      },
      onPartial: (listener) => {
        partialListeners.push(listener);
      },
      onFinal: (listener) => {
        finalListeners.push(listener);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        connection.close();
      },
    };
  }
}
