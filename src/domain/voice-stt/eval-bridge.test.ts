import { describe, it, expect } from 'vitest';
import { VOICE_EVAL_SCHEMA_VERSION, validateVoiceEvalSession, type VoiceEvalSession } from '@/domain/voice/evaluation-events';
import {
  VOICE_STT_ERROR_CODES,
  entityResolvedEvent,
  sttErrorEvent,
  sttFinalEvent,
  sttPartialEvent,
  sttSessionAbortedEvent,
} from './eval-bridge';
import type { EntityCandidate } from './entity-resolver';

describe('voice-stt eval-bridge', () => {
  it('maps a PartialTranscript to a schema-valid stt.partial event', () => {
    const event = sttPartialEvent({ text: 'たなか', stable: false, confidence: 0.7, t: 120 });
    expect(event).toEqual({ type: 'stt.partial', t: 120, turnIndex: 0, text: 'たなか', stable: false });
  });

  it('maps a stable PartialTranscript to stable: true', () => {
    const event = sttPartialEvent({ text: 'たなか', stable: true, confidence: 0.9, t: 300 }, 2);
    expect(event).toEqual({ type: 'stt.partial', t: 300, turnIndex: 2, text: 'たなか', stable: true });
  });

  it('maps a FinalTranscript to a schema-valid stt.final event', () => {
    const event = sttFinalEvent({ text: '田中です', confidence: 0.95, t: 900 });
    expect(event).toEqual({ type: 'stt.final', t: 900, turnIndex: 0, text: '田中です' });
  });

  it('maps entity candidates (already score-descending) to entity.resolved', () => {
    const candidates: EntityCandidate[] = [
      { id: 'staff-tanaka', kind: 'staff', displayName: '田中 美咲', entityConfidence: 0.9 },
      { id: 'dept-hr', kind: 'department', displayName: '人事部', entityConfidence: 0.4 },
    ];
    const event = entityResolvedEvent(950, '田中', candidates);
    expect(event).toEqual({
      type: 'entity.resolved',
      t: 950,
      turnIndex: 0,
      query: '田中',
      candidates: [
        { id: 'staff-tanaka', kind: 'staff', score: 0.9 },
        { id: 'dept-hr', kind: 'department', score: 0.4 },
      ],
    });
  });

  it('produces error and session.aborted events at the stt stage with an enumerable code', () => {
    const err = sttErrorEvent(10, 'stream_error');
    expect(err).toEqual({ type: 'error', t: 10, turnIndex: 0, stage: 'stt', code: 'stream_error' });
    const aborted = sttSessionAbortedEvent(20, 'stream_error');
    expect(aborted).toEqual({ type: 'session.aborted', t: 20, turnIndex: 0, stage: 'stt', code: 'stream_error' });
    expect(VOICE_STT_ERROR_CODES).toContain('stream_error');
  });

  it('produces a full session that satisfies validateVoiceEvalSession (issue #365 conformance gate)', () => {
    const session: VoiceEvalSession = {
      schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
      sessionId: 'voice-stt-eval-bridge-test',
      locale: 'ja-JP',
      providers: { stt: 'mock-stt', tts: 'n/a', turn: 'n/a' },
      events: [
        { type: 'audio.onset', t: 0, turnIndex: 0 },
        sttPartialEvent({ text: 'たなか', stable: false, confidence: 0.5, t: 80 }),
        sttPartialEvent({ text: 'たなか', stable: true, confidence: 0.8, t: 260 }),
        sttFinalEvent({ text: '田中さんお願いします', confidence: 0.92, t: 900 }),
        entityResolvedEvent(950, '田中', [
          { id: 'staff-tanaka', kind: 'staff', displayName: '田中 美咲', entityConfidence: 0.9 },
        ]),
      ],
      groundTruth: { turns: [], nearEndStimuli: [] },
    };

    const result = validateVoiceEvalSession(session);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
