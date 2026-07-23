import { describe, it, expect } from 'vitest';
import { VOICE_EVAL_SCHEMA_VERSION, validateVoiceEvalSession, type VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import {
  transportConnectedEvent,
  transportStreamOpenEvent,
  transportReconnectingEvent,
  transportDisconnectedEvent,
  transportStatsEvent,
  transportErrorEvent,
  transportSessionAbortedEvent,
} from './eval-bridge';

describe('eval-bridge transport event constructors', () => {
  it('builds transport.connected matching the #365 schema', () => {
    expect(transportConnectedEvent(10)).toEqual({ type: 'transport.connected', t: 10, turnIndex: 0 });
  });

  it('builds transport.stream_open', () => {
    expect(transportStreamOpenEvent(20, 1)).toEqual({ type: 'transport.stream_open', t: 20, turnIndex: 1 });
  });

  it('builds transport.reconnecting with attempt', () => {
    expect(transportReconnectingEvent(30, 2)).toEqual({ type: 'transport.reconnecting', t: 30, turnIndex: 0, attempt: 2 });
  });

  it('builds transport.disconnected with a valid reason', () => {
    expect(transportDisconnectedEvent(40, 'network')).toEqual({
      type: 'transport.disconnected',
      t: 40,
      turnIndex: 0,
      reason: 'network',
    });
  });

  it('builds transport.stats with dropped packets and jitter', () => {
    expect(transportStatsEvent(50, { droppedPackets: 3, jitterMs: 12 })).toEqual({
      type: 'transport.stats',
      t: 50,
      turnIndex: 0,
      droppedPackets: 3,
      jitterMs: 12,
    });
  });

  it('builds a transport-stage error event with a short enumerable code', () => {
    expect(transportErrorEvent(60, 'token_rejected')).toEqual({
      type: 'error',
      t: 60,
      turnIndex: 0,
      stage: 'transport',
      code: 'token_rejected',
    });
  });

  it('builds a transport-stage session.aborted event', () => {
    expect(transportSessionAbortedEvent(70, 'reconnect_exhausted')).toEqual({
      type: 'session.aborted',
      t: 70,
      turnIndex: 0,
      stage: 'transport',
      code: 'reconnect_exhausted',
    });
  });

  it('a realistic transport-only session built from these constructors passes validateVoiceEvalSession with zero errors', () => {
    const events: VoiceEvalEvent[] = [
      transportConnectedEvent(0),
      transportStreamOpenEvent(5),
      transportReconnectingEvent(1000, 1),
      transportDisconnectedEvent(1000, 'network'),
      transportStatsEvent(1500, { droppedPackets: 2, jitterMs: 8 }),
      transportConnectedEvent(1800),
    ];
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'transport-eval-sample-1',
      locale: 'ja-JP',
      providers: { stt: 'none', tts: 'none', turn: 'none', transport: 'voice-transport-mock' },
      events,
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors).toEqual([]);
  });

  it('a session that aborts mid-stream still validates (abort is a performance signal, not a schema violation)', () => {
    const events: VoiceEvalEvent[] = [
      transportConnectedEvent(0),
      transportStreamOpenEvent(5),
      transportReconnectingEvent(100, 1),
      transportReconnectingEvent(300, 2),
      transportSessionAbortedEvent(900, 'reconnect_exhausted'),
    ];
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'transport-eval-sample-2',
      locale: 'ja-JP',
      providers: { stt: 'none', tts: 'none', turn: 'none', transport: 'voice-transport-mock' },
      events,
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors).toEqual([]);
  });
});
