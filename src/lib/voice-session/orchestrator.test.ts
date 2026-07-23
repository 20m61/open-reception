/**
 * `VoiceSessionOrchestrator` 統合テスト (issue #364)。
 *
 * #369(Transport)/#370(STT)/#371(TTS)/#372(Turn) の mock 実装をそのまま合成し、interface + mock
 * だけで「mic → STT → turn 確定 → TTS 応答 → barge-in 停止」が実際に完走することを検証する。
 * 実 WebSocket/実 AWS 認証情報は使わない（#65 運用制約）。
 */
import { describe, it, expect, vi } from 'vitest';
import { VoiceSessionOrchestrator, type VoiceSessionConfig, type VoiceSessionProviders, type VoiceSessionCallbacks } from './orchestrator';
import type { VoiceTransportSocket, VoiceTransportSocketCloseInfo } from '@/lib/voice-transport/socket';
import { createMockSttProvider, type MockSttScript } from '@/lib/voice-stt/mock-provider';
import { MockStreamingTtsProvider } from '@/lib/voice-tts/mock-provider';
import { InMemoryTtsCache } from '@/lib/voice-tts/cache-store';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import {
  validateVoiceEvalSession,
  VOICE_EVAL_SCHEMA_VERSION,
  type VoiceEvalEvent,
  type VoiceEvalSession,
} from '@/domain/voice/evaluation-events';
import type { VoiceSessionFallbackEvent } from '@/domain/voice-session/types';

class MockSocket implements VoiceTransportSocket {
  sent: ArrayBuffer[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: ((info: VoiceTransportSocketCloseInfo) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;

  send(chunk: ArrayBuffer): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(chunk);
  }
  close(): void {
    this.closed = true;
  }
  triggerOpen(): void {
    this.onopen?.();
  }
  triggerClose(info: VoiceTransportSocketCloseInfo = {}): void {
    this.closed = true;
    this.onclose?.(info);
  }
}

function makeSocketFactory(): { factory: () => MockSocket; sockets: MockSocket[] } {
  const sockets: MockSocket[] = [];
  const factory = (): MockSocket => {
    const socket = new MockSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

function makeTransportConfig(socketFactory: () => MockSocket, overrides: Partial<VoiceSessionConfig['transport']> = {}): VoiceSessionConfig['transport'] {
  return {
    url: 'wss://example.invalid/voice',
    socketFactory,
    queueLimits: { maxChunks: 50, maxBytes: 500_000, dropPolicy: 'drop-oldest' },
    rateLimit: { capacity: 1000, refillPerMs: 1000 },
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    reconnect: { backoff: { baseMs: 200, maxMs: 2_000 }, maxAttempts: 2 },
    ...overrides,
  };
}

function buildSession(opts: {
  sttScript?: MockSttScript;
  callbacks?: VoiceSessionCallbacks;
  transportOverrides?: Partial<VoiceSessionConfig['transport']>;
}) {
  const { factory, sockets } = makeSocketFactory();
  const sttProvider = createMockSttProvider(opts.sttScript ?? { partials: [], final: { afterChunk: 1, text: '', confidence: 0 } });
  const ttsProvider = new MockStreamingTtsProvider();
  const ttsCache = new InMemoryTtsCache();
  const config: VoiceSessionConfig = {
    transport: makeTransportConfig(factory, opts.transportOverrides),
    stt: { locale: 'ja-JP', audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG },
  };
  const providers: VoiceSessionProviders = { sttProvider, ttsProvider, ttsCache };
  const session = new VoiceSessionOrchestrator(config, providers, opts.callbacks);
  return { session, sockets, sttProvider, ttsProvider, ttsCache };
}

function makeUtterance(utteranceId: string, text: string) {
  return {
    utteranceId,
    locale: 'ja-JP',
    voice: 'Takumi',
    engine: 'neural' as const,
    rate: 1,
    lexiconVersion: 'v1',
    text: { displayText: text },
  };
}

describe('VoiceSessionOrchestrator — full flow (issue #364 統合: mic→STT→turn確定→TTS応答→barge-in停止)', () => {
  it('一連の synthetic フローが完走し、生成された eval イベントが #365 検証を通る', async () => {
    let t = 0;
    const evalEvents: VoiceEvalEvent[] = [];
    const fallbacks: VoiceSessionFallbackEvent[] = [];
    const vrmStates: string[] = [];
    let committed: { text: string; trigger: string } | null = null;

    const { session, sockets } = buildSession({
      sttScript: {
        partials: [{ afterChunk: 1, text: '配送で', confidence: 0.8 }],
        final: { afterChunk: 2, text: '配送でお伺いしました', confidence: 0.9 },
      },
      callbacks: {
        now: () => t,
        onEvalEvent: (e) => evalEvents.push(e),
        onFallback: (e) => fallbacks.push(e),
        onVrmStateChange: (s) => vrmStates.push(s),
        onTurnCommitted: (text, trigger) => {
          committed = { text, trigger };
        },
      },
    });

    await session.start();
    sockets[0]!.triggerOpen();

    // --- mic → Transport(#369) + STT(#370) ---
    session.pushMicChunk(new ArrayBuffer(320));
    session.pushMicChunk(new ArrayBuffer(320));
    expect(sockets[0]!.sent.length).toBe(2);

    // --- Turn(#372): 発話終了 → 無音 → 確定 ---
    t = 100;
    session.reportSpeechStarted();
    t = 1000;
    session.reportSpeechEnded('配送でお伺いしました');
    t = 1500; // silenceMs=500 は baseSilenceMs(500) を満たす（slot 未指定）。
    session.reportSilenceTick(500);

    expect(committed).toEqual({ text: '配送でお伺いしました', trigger: 'silence' });

    // --- 上位（受付ロジック相当）が応答を TTS(#371) で再生する ---
    t = 1510;
    const speakResult = await session.speak(makeUtterance('resp-1', '配送の件、承知いたしました'));
    expect(speakResult.outcome).toBe('generated');
    expect(session.isSpeaking()).toBe(true);
    expect(vrmStates.at(-1)).toBe('speaking');

    // --- barge-in(#372): 明示的訂正で即座に停止 ---
    t = 1610;
    session.reportNearEndOnset();
    t = 1700;
    session.reportNearEndUpdate({ text: '戻って', sustainedMs: 90 });

    expect(session.isSpeaking()).toBe(false);
    expect(vrmStates.at(-1)).toBe('listening');
    expect(fallbacks).toEqual([]); // どの層も障害を起こしていない。

    await session.close();

    const evalSession: VoiceEvalSession = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'orchestrator-integration-test',
      locale: 'ja-JP',
      providers: { stt: 'mock-stt', tts: 'mock-tts', turn: 'voice-session-orchestrator', transport: 'mock-transport' },
      events: [...evalEvents].sort((a, b) => a.t - b.t),
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(evalSession);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    // 実際に platform 層のイベントが出ていることも確認する（空イベント列での見かけ green を防ぐ）。
    expect(evalEvents.some((e) => e.type === 'transport.connected')).toBe(true);
    expect(evalEvents.some((e) => e.type === 'stt.final')).toBe(true);
    expect(evalEvents.some((e) => e.type === 'turn.committed')).toBe(true);
    expect(evalEvents.some((e) => e.type === 'tts.request')).toBe(true);
    expect(evalEvents.filter((e) => e.type === 'tts.playback_start')).toHaveLength(1); // 二重発火していない。
    expect(evalEvents.some((e) => e.type === 'tts.playback_stopped' && e.reason === 'barge_in')).toBe(true);
  });
});

describe('VoiceSessionOrchestrator — duck/resume と stop の使い分け(#372 reducer 出力どおりに TTS へ伝わる)', () => {
  it('backchannel は duck→resume のみ(stop されない)', async () => {
    const t = 0;
    const evalEvents: VoiceEvalEvent[] = [];
    const { session, sockets } = buildSession({ callbacks: { now: () => t, onEvalEvent: (e) => evalEvents.push(e) } });
    await session.start();
    sockets[0]!.triggerOpen();

    await session.speak(makeUtterance('u1', '受付が承ります'));
    expect(session.isSpeaking()).toBe(true);

    session.reportNearEndOnset();
    session.reportNearEndUpdate({ text: 'はい', sustainedMs: 200 }); // 相づち → resume。

    expect(session.isSpeaking()).toBe(true); // 停止していない。
    expect(evalEvents.some((e) => e.type === 'tts.playback_stopped')).toBe(false);

    await session.close();
  });

  it('true interruption は stop_and_discard(再生停止 + キュー破棄)される', async () => {
    const t = 0;
    const evalEvents: VoiceEvalEvent[] = [];
    const { session, sockets } = buildSession({ callbacks: { now: () => t, onEvalEvent: (e) => evalEvents.push(e) } });
    await session.start();
    sockets[0]!.triggerOpen();

    await session.speak(makeUtterance('u1', '受付が承ります'));
    session.reportNearEndOnset();
    session.reportNearEndUpdate({ text: 'ちょっと待って', sustainedMs: 10 }); // 強制停止フレーズ。

    expect(session.isSpeaking()).toBe(false);
    const stopped = evalEvents.find((e) => e.type === 'tts.playback_stopped');
    expect(stopped).toMatchObject({ type: 'tts.playback_stopped', reason: 'barge_in' });

    await session.close();
  });

  it('自己音声エコーは resume される(誤って停止しない)', async () => {
    const { session, sockets } = buildSession({});
    await session.start();
    sockets[0]!.triggerOpen();

    await session.speak(makeUtterance('u1', '受付が承ります'));
    session.reportNearEndOnset();
    session.reportNearEndUpdate({ text: 'そうです', sustainedMs: 90, echoLikelihood: 0.9 });

    expect(session.isSpeaking()).toBe(true);
    await session.close();
  });
});

describe('VoiceSessionOrchestrator — TTS suppression と barge-in の共存(issue #364 統合スコープ)', () => {
  it('updateTtsSuppression が有効化されると、再生中の utterance を直ちに停止・破棄する', async () => {
    const { session, sockets } = buildSession({});
    await session.start();
    sockets[0]!.triggerOpen();

    await session.speak(makeUtterance('u1', '受付が承ります'));
    expect(session.isSpeaking()).toBe(true);

    session.updateTtsSuppression({ callConnected: true, liveBridgeActive: false });

    expect(session.isSpeaking()).toBe(false);

    await session.close();
  });

  it('suppression が有効な間 speak() は合成すら行わず suppressed を返す', async () => {
    const { session, sockets, ttsProvider } = buildSession({});
    const synthesizeSpy = vi.spyOn(ttsProvider, 'synthesize');
    await session.start();
    sockets[0]!.triggerOpen();

    session.updateTtsSuppression({ callConnected: false, liveBridgeActive: true });
    const result = await session.speak(makeUtterance('u1', '受付が承ります'));

    expect(result).toEqual({ outcome: 'suppressed' });
    expect(synthesizeSpy).not.toHaveBeenCalled();
    expect(session.isSpeaking()).toBe(false);

    await session.close();
  });
});

describe('VoiceSessionOrchestrator — フォールバックの正規化(issue #364 統合: どの層の障害でも1つのfallbackイベントに正規化)', () => {
  it('Transport(#369) の再接続枯渇は source: transport で正規化される', async () => {
    const fallbacks: VoiceSessionFallbackEvent[] = [];
    const { session, sockets } = buildSession({
      callbacks: { onFallback: (e) => fallbacks.push(e) },
      transportOverrides: { reconnect: { backoff: { baseMs: 200, maxMs: 2_000 }, maxAttempts: 0 } },
    });
    await session.start();
    sockets[0]!.triggerOpen();
    sockets[0]!.triggerClose(); // network 切断 → reconnecting → maxAttempts(0) 到達 → degraded。

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ type: 'voiceSessionFallbackRequired', source: 'transport' });

    await session.close();
  });

  it('STT(#370) の障害報告は source: stt で正規化される', async () => {
    const fallbacks: VoiceSessionFallbackEvent[] = [];
    const { session, sockets } = buildSession({ callbacks: { onFallback: (e) => fallbacks.push(e) } });
    await session.start();
    sockets[0]!.triggerOpen();

    session.reportSttFallback({ type: 'voiceSttFallbackRequired', reason: 'no_partial_timeout', t: 500 });

    expect(fallbacks).toEqual([{ type: 'voiceSessionFallbackRequired', source: 'stt', reason: 'no_partial_timeout', t: 500 }]);

    await session.close();
  });

  it('TTS(#371) の provider 障害は speak() 内で自動検出され source: tts で正規化される(継続は可能)', async () => {
    const fallbacks: VoiceSessionFallbackEvent[] = [];
    const failingTtsProvider = { synthesize: async function* () { throw new Error('boom'); } };
    const { factory } = makeSocketFactory();
    const session = new VoiceSessionOrchestrator(
      { transport: makeTransportConfig(factory), stt: { locale: 'ja-JP', audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } },
      { sttProvider: createMockSttProvider({ partials: [], final: { afterChunk: 1, text: '', confidence: 0 } }), ttsProvider: failingTtsProvider, ttsCache: new InMemoryTtsCache() },
      { onFallback: (e) => fallbacks.push(e) },
    );
    await session.start();

    const result = await session.speak(makeUtterance('u1', '受付が承ります'));

    expect(result.outcome).toBe('fallback_caption'); // #371 AC どおり字幕で継続可能。
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ type: 'voiceSessionFallbackRequired', source: 'tts', reason: 'provider_error' });
    expect(session.isSpeaking()).toBe(false); // caption only なので再生キューには積まれない。

    await session.close();
  });

  it('Turn/barge-in(#372) の障害報告は source: turn で正規化される', async () => {
    const fallbacks: VoiceSessionFallbackEvent[] = [];
    const { session, sockets } = buildSession({ callbacks: { onFallback: (e) => fallbacks.push(e) } });
    await session.start();
    sockets[0]!.triggerOpen();

    session.reportTurnFallback('vad_unavailable', 999);

    expect(fallbacks).toEqual([{ type: 'voiceSessionFallbackRequired', source: 'turn', reason: 'vad_unavailable', t: 999 }]);

    await session.close();
  });
});

describe('VoiceSessionOrchestrator — close の冪等性(issue #364 統合: #369 registerCloseHook 経由で全層 close)', () => {
  it('STT(#370) session の close は #369 registerCloseHook 経由で1回だけ走る(二重 close 安全)', async () => {
    const innerProvider = createMockSttProvider({ partials: [], final: { afterChunk: 1, text: '', confidence: 0 } });
    const closeSpy = vi.fn();
    const wrappingProvider = {
      start: async (config: Parameters<typeof innerProvider.start>[0]) => {
        const inner = await innerProvider.start(config);
        return { ...inner, close: async () => { closeSpy(); await inner.close(); } };
      },
    };
    const { factory, sockets } = makeSocketFactory();
    const session = new VoiceSessionOrchestrator(
      { transport: makeTransportConfig(factory), stt: { locale: 'ja-JP', audio: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } },
      { sttProvider: wrappingProvider, ttsProvider: new MockStreamingTtsProvider(), ttsCache: new InMemoryTtsCache() },
    );
    await session.start();
    sockets[0]!.triggerOpen();

    await session.close();
    await session.close();
    await session.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('close() はアクティブな TTS(#371) 再生を停止する(#369 close hook 経由)。二重 close は例外を投げない', async () => {
    const { session, sockets } = buildSession({});
    await session.start();
    sockets[0]!.triggerOpen();

    await session.speak(makeUtterance('u1', '受付が承ります'));
    expect(session.isSpeaking()).toBe(true);

    await session.close();
    expect(session.isSpeaking()).toBe(false);

    await expect(session.close()).resolves.toBeUndefined(); // 二重 close。
  });

  it('close() 後は pushMicChunk/speak/barge-in 系メソッドが no-op になる', async () => {
    const { session, sockets, ttsProvider } = buildSession({});
    const synthesizeSpy = vi.spyOn(ttsProvider, 'synthesize');
    await session.start();
    sockets[0]!.triggerOpen();
    await session.close();

    session.pushMicChunk(new ArrayBuffer(10));
    session.reportSpeechStarted();
    session.reportNearEndOnset();
    const result = await session.speak(makeUtterance('u1', 'x'));

    expect(result).toEqual({ outcome: 'suppressed' });
    expect(synthesizeSpy).not.toHaveBeenCalled();
    expect(sockets[0]!.sent).toEqual([]); // close 後は transport にも送出されない。
  });
});
