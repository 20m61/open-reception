import { describe, expect, it } from 'vitest';

import {
  VOICE_EVAL_SCHEMA_VERSION,
  countNearEndOnsets,
  isPlaybackActiveAt,
  observedNearEndOnsets,
  playbackWindows,
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
    groundTruth: { turns: [], nearEndStimuli: [] },
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
    const result = validateVoiceEvalSession(session({ schemaVersion: 1 }));
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
    expect(validateVoiceEvalSession(session({ events })).valid).toBe(false);
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

  it('accepts ground truth for a turn the provider produced no events for (脱落は性能の失敗)', () => {
    // ターンの脱落は missedEndRate として計測されるべきもの。スキーマ違反にすると
    // 「実装が壊れた」が「計測が壊れた」として現れ、両者を区別できなくなる。
    const result = validateVoiceEvalSession(
      session({
        groundTruth: {
          turns: [{ turnIndex: 7, referenceTranscript: 'x', shouldCommit: true, endsWithFiller: false }],
          nearEndStimuli: [],
        },
      }),
    );
    expect(result.errors).toEqual([]);
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

  it('rejects an error event carrying a full exception message instead of a code', () => {
    const events: VoiceEvalEvent[] = [{ t: 0, turnIndex: 0, type: 'error', stage: 'stt', code: 'x'.repeat(65) }];
    const result = validateVoiceEvalSession(session({ events }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toContain('長すぎる');
  });

  it('accepts transport and failure events (#369 が計測値を出せる)', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'transport.connected' },
      { t: 5, turnIndex: 0, type: 'transport.stream_open' },
      { t: 10, turnIndex: 0, type: 'transport.stats', droppedPackets: 2, jitterMs: 18 },
      { t: 20, turnIndex: 0, type: 'transport.reconnecting', attempt: 1 },
      { t: 30, turnIndex: 0, type: 'transport.disconnected', reason: 'network' },
      { t: 40, turnIndex: 0, type: 'error', stage: 'stt', code: 'stream_timeout' },
      { t: 50, turnIndex: 0, type: 'session.aborted', stage: 'transport', code: 'closed' },
    ];
    expect(validateVoiceEvalSession(session({ events })).errors).toEqual([]);
  });

  it('rejects a reconnect attempt number below 1', () => {
    const events: VoiceEvalEvent[] = [{ t: 0, turnIndex: 0, type: 'transport.reconnecting', attempt: 0 }];
    expect(validateVoiceEvalSession(session({ events })).valid).toBe(false);
  });

  describe('近端発話の正解（刺激ベース）', () => {
    it('accepts a stimulus with no matching observation (検出漏れは指標であって違反ではない)', () => {
      const result = validateVoiceEvalSession(
        session({
          groundTruth: {
            turns: [],
            nearEndStimuli: [{ id: 'a', atMs: 99_000, toleranceMs: 200, label: 'interruption' }],
          },
        }),
      );
      expect(result.errors).toEqual([]);
    });

    it('rejects duplicate stimulus ids', () => {
      const result = validateVoiceEvalSession(
        session({
          groundTruth: {
            turns: [],
            nearEndStimuli: [
              { id: 'dup', atMs: 100, toleranceMs: 200, label: 'echo' },
              { id: 'dup', atMs: 300, toleranceMs: 200, label: 'echo' },
            ],
          },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toContain('重複');
    });

    it('rejects a non-positive tolerance', () => {
      const result = validateVoiceEvalSession(
        session({
          groundTruth: { turns: [], nearEndStimuli: [{ id: 'a', atMs: 100, toleranceMs: 0, label: 'echo' }] },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toContain('toleranceMs');
    });

    it('rejects tolerance windows that overlap (刺激間隔より広い許容窓は帰属を壊す)', () => {
      // 許容窓が刺激間隔以上に広いと「どちらの刺激の観測か」が原理的に決まらない。
      // データセット側の設定ミスなので、指標として現れる前に構造的に弾く。
      const result = validateVoiceEvalSession(
        session({
          groundTruth: {
            turns: [],
            nearEndStimuli: [
              { id: 'backchannel', atMs: 1540, toleranceMs: 400, label: 'backchannel' },
              { id: 'interruption', atMs: 1940, toleranceMs: 400, label: 'interruption' },
            ],
          },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toContain('toleranceMs');
    });

    it('accepts tolerance windows that stay clear of each other', () => {
      const result = validateVoiceEvalSession(
        session({
          groundTruth: {
            turns: [],
            nearEndStimuli: [
              { id: 'backchannel', atMs: 1540, toleranceMs: 150, label: 'backchannel' },
              { id: 'interruption', atMs: 1940, toleranceMs: 150, label: 'interruption' },
            ],
          },
        }),
      );
      expect(result.errors).toEqual([]);
    });

    it('rejects an unknown label', () => {
      const result = validateVoiceEvalSession(
        session({
          groundTruth: {
            turns: [],
            nearEndStimuli: [{ id: 'a', atMs: 100, toleranceMs: 200, label: 'cough' as never }],
          },
        }),
      );
      expect(result.valid).toBe(false);
    });
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

describe('playbackWindows', () => {
  it('records a terminated window with its stop reason', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
    ];
    expect(playbackWindows(events)).toEqual([{ start: 100, stop: 500, reason: 'completed', terminated: true }]);
  });

  it('keeps a playback that never stopped, extending it to the end of the session', () => {
    // 再生が全く止まらないのは barge-in の最悪の失敗。捨てると近端 onset ごと指標から消える。
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 900, turnIndex: 0, type: 'speech.end' },
    ];
    expect(playbackWindows(events)).toEqual([{ start: 100, stop: 900, reason: 'unterminated', terminated: false }]);
    expect(countNearEndOnsets(events)).toBe(1);
  });

  it('closes an unterminated window when the next playback starts', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 400, turnIndex: 1, type: 'tts.playback_start' },
      { t: 900, turnIndex: 1, type: 'tts.playback_stopped', reason: 'completed' },
    ];
    expect(playbackWindows(events).map((w) => w.reason)).toEqual(['unterminated', 'completed']);
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

describe('observedNearEndOnsets', () => {
  it('returns only the audio onsets that land during playback', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 10, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 200, turnIndex: 0, type: 'audio.onset' },
      { t: 500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
      { t: 900, turnIndex: 1, type: 'audio.onset' },
    ];
    const onsets = observedNearEndOnsets(events);
    expect(onsets).toHaveLength(1);
    expect(onsets[0]?.t).toBe(200);
  });
});
