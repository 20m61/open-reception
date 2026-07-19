import { describe, expect, it } from 'vitest';

import {
  VOICE_EVAL_SCHEMA_VERSION,
  countNearEndOnsets,
  isPlaybackActiveAt,
  sortVoiceEvalEvents,
  validateVoiceEvalSession,
  type VoiceEvalEvent,
  type VoiceEvalSession,
} from './evaluation-events';

function session(overrides: Partial<VoiceEvalSession> = {}): VoiceEvalSession {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'audio.onset' },
    { t: 200, turnIndex: 0, type: 'stt.partial', text: 'やま', stable: false },
    { t: 320, turnIndex: 0, type: 'stt.partial', text: 'やまだ', stable: true },
    { t: 600, turnIndex: 0, type: 'speech.end' },
    { t: 640, turnIndex: 0, type: 'stt.final', text: '山田さんにお会いしたい' },
    { t: 700, turnIndex: 0, type: 'turn.committed', text: '山田さんにお会いしたい', trigger: 'silence' },
    { t: 710, turnIndex: 0, type: 'tts.request', text: '山田を呼び出します' },
    { t: 830, turnIndex: 0, type: 'tts.first_byte' },
    { t: 900, turnIndex: 0, type: 'tts.playback_start' },
    { t: 1400, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
  ];
  return {
    schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
    sessionId: 's1',
    locale: 'ja-JP',
    providers: { stt: 'mock-stt', tts: 'mock-tts', turn: 'mock-turn' },
    events,
    groundTruth: { turns: [], nearEndOnsets: [] },
    ...overrides,
  };
}

describe('validateVoiceEvalSession', () => {
  it('accepts a well-formed session', () => {
    const result = validateVoiceEvalSession(session());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a schema version it cannot interpret', () => {
    const result = validateVoiceEvalSession(session({ schemaVersion: 999 }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('schemaVersion');
  });

  it('rejects non-monotonic timestamps so latency math never goes negative', () => {
    const events: VoiceEvalEvent[] = [
      { t: 100, turnIndex: 0, type: 'audio.onset' },
      { t: 50, turnIndex: 0, type: 'speech.end' },
    ];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('単調増加');
  });

  it('rejects negative timestamps', () => {
    const events: VoiceEvalEvent[] = [{ t: -1, turnIndex: 0, type: 'audio.onset' }];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const events = [{ t: 0, turnIndex: 0, type: 'stt.magic' }] as unknown as VoiceEvalEvent[];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('stt.magic');
  });

  it('rejects a partial event missing its stability flag', () => {
    const events = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 10, turnIndex: 0, type: 'stt.partial', text: 'あ' },
    ] as unknown as VoiceEvalEvent[];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('stable');
  });

  it('rejects playback start with no preceding synthesis request', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
    ];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('tts.request');
  });

  it('rejects ground truth referring to a turn that has no events', () => {
    const result = validateVoiceEvalSession(
      session({
        groundTruth: {
          turns: [{ turnIndex: 7, referenceTranscript: 'x', shouldCommit: true, endsWithFiller: false }],
          nearEndOnsets: [],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('turnIndex 7');
  });

  it('rejects a near-end annotation with no matching audio onset', () => {
    const result = validateVoiceEvalSession(
      session({ groundTruth: { turns: [], nearEndOnsets: [{ onsetIndex: 5, label: 'interruption' }] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('onsetIndex 5');
  });

  it('rejects an entity event whose candidates are not ranked by descending score', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      {
        t: 10,
        turnIndex: 0,
        type: 'entity.resolved',
        query: '山田',
        candidates: [
          { id: 'a', kind: 'staff', score: 0.2 },
          { id: 'b', kind: 'staff', score: 0.9 },
        ],
      },
    ];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('降順');
  });

  it('rejects personally identifying raw audio references in the event stream', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 10, turnIndex: 0, type: 'stt.final', text: '山田', audioUri: 's3://bucket/raw.wav' } as VoiceEvalEvent,
    ];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('audioUri');
  });
});

describe('sortVoiceEvalEvents', () => {
  it('orders by timestamp without mutating the input', () => {
    const input: VoiceEvalEvent[] = [
      { t: 300, turnIndex: 0, type: 'speech.end' },
      { t: 100, turnIndex: 0, type: 'audio.onset' },
    ];
    const sorted = sortVoiceEvalEvents(input);
    expect(sorted.map((e) => e.t)).toEqual([100, 300]);
    expect(input[0]?.t).toBe(300);
  });
});

describe('isPlaybackActiveAt', () => {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
    { t: 100, turnIndex: 0, type: 'tts.playback_start' },
    { t: 500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
  ];

  it('is true strictly inside a playback window', () => {
    expect(isPlaybackActiveAt(events, 300)).toBe(true);
  });

  it('is false before playback starts and after it stops', () => {
    expect(isPlaybackActiveAt(events, 50)).toBe(false);
    expect(isPlaybackActiveAt(events, 600)).toBe(false);
  });
});

describe('countNearEndOnsets', () => {
  it('counts only the audio onsets that land during playback', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 10, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 200, turnIndex: 0, type: 'audio.onset' },
      { t: 500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
      { t: 900, turnIndex: 1, type: 'audio.onset' },
    ];
    expect(countNearEndOnsets(events)).toBe(1);
  });
});
