import { describe, it, expect } from 'vitest';
import { VOICE_EVAL_SCHEMA_VERSION, validateVoiceEvalSession, type VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import {
  ttsRequestEvent,
  ttsFirstByteEvent,
  ttsPlaybackStartEvent,
  ttsPlaybackStoppedEvent,
  vrmVisemeAppliedEvent,
  ttsErrorEvent,
  ttsSessionAbortedEvent,
  TTS_ERROR_CODES,
} from './eval-bridge';

describe('eval-bridge TTS event constructors (issue #371 → #365 適合)', () => {
  it('builds tts.request with text', () => {
    expect(ttsRequestEvent(0, 'ようこそ')).toEqual({ type: 'tts.request', t: 0, turnIndex: 0, text: 'ようこそ' });
  });

  it('builds tts.first_byte (first-byte timing)', () => {
    expect(ttsFirstByteEvent(50, 1)).toEqual({ type: 'tts.first_byte', t: 50, turnIndex: 1 });
  });

  it('builds tts.playback_start (first-audio timing)', () => {
    expect(ttsPlaybackStartEvent(120)).toEqual({ type: 'tts.playback_start', t: 120, turnIndex: 0 });
  });

  it('builds tts.playback_stopped with a valid reason (completion timing uses reason=completed)', () => {
    expect(ttsPlaybackStoppedEvent(500, 'completed')).toEqual({
      type: 'tts.playback_stopped',
      t: 500,
      turnIndex: 0,
      reason: 'completed',
    });
  });

  it('builds vrm.viseme_applied with audioTimestampMs (viseme timing)', () => {
    expect(vrmVisemeAppliedEvent(130, 20)).toEqual({ type: 'vrm.viseme_applied', t: 130, turnIndex: 0, audioTimestampMs: 20 });
  });

  it('builds a tts-stage error event with a short enumerable code', () => {
    expect(ttsErrorEvent(60, 'provider_error')).toEqual({ type: 'error', t: 60, turnIndex: 0, stage: 'tts', code: 'provider_error' });
  });

  it('builds a tts-stage session.aborted event', () => {
    expect(ttsSessionAbortedEvent(70, 'playback_error')).toEqual({
      type: 'session.aborted',
      t: 70,
      turnIndex: 0,
      stage: 'tts',
      code: 'playback_error',
    });
  });

  it('every TTS_ERROR_CODES entry is within the 64-char limit the #365 validator enforces', () => {
    for (const code of TTS_ERROR_CODES) expect(code.length).toBeLessThanOrEqual(64);
  });

  it('a realistic TTS-only session built from these constructors passes validateVoiceEvalSession with zero errors', () => {
    const events: VoiceEvalEvent[] = [
      ttsRequestEvent(0, 'ようこそ、受付システムです'),
      ttsFirstByteEvent(80),
      ttsPlaybackStartEvent(150),
      vrmVisemeAppliedEvent(160, 10),
      vrmVisemeAppliedEvent(200, 50),
      ttsPlaybackStoppedEvent(2000, 'completed'),
    ];
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'tts-eval-sample-1',
      locale: 'ja-JP',
      providers: { stt: 'none', tts: 'voice-tts-mock', turn: 'none' },
      events,
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors).toEqual([]);
  });

  it('a session where TTS is interrupted (barge_in) mid-playback still validates (performance signal, not a schema violation)', () => {
    const events: VoiceEvalEvent[] = [
      ttsRequestEvent(0, 'ご用件をお伺いします'),
      ttsFirstByteEvent(60),
      ttsPlaybackStartEvent(100),
      ttsPlaybackStoppedEvent(300, 'barge_in'),
    ];
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'tts-eval-sample-2',
      locale: 'ja-JP',
      providers: { stt: 'none', tts: 'voice-tts-mock', turn: 'none' },
      events,
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors).toEqual([]);
  });

  it('a session that emits tts.playback_start without a preceding tts.request fails validation (regression guard for #365 ordering rule)', () => {
    const events: VoiceEvalEvent[] = [ttsPlaybackStartEvent(0)];
    const session = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'tts-eval-sample-3',
      locale: 'ja-JP',
      providers: { stt: 'none', tts: 'voice-tts-mock', turn: 'none' },
      events,
      groundTruth: { turns: [], nearEndStimuli: [] },
    };
    const validation = validateVoiceEvalSession(session);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});
