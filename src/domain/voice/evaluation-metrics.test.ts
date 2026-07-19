import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import {
  characterErrorRate,
  computeBargeInMetrics,
  computeEntityMetrics,
  computeLatencyMetrics,
  computeSessionMetrics,
  computeSttMetrics,
  computeTurnMetrics,
  latencySummary,
  percentile,
} from './evaluation-metrics';

describe('percentile', () => {
  it('returns null for an empty sample set (undecidable, never a silent 0)', () => {
    expect(percentile([], 50)).toBeNull();
  });

  it('returns the single sample regardless of the requested percentile', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('interpolates linearly between neighbouring samples', () => {
    expect(percentile([0, 100], 50)).toBe(50);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  it('is order independent', () => {
    expect(percentile([30, 10, 20], 50)).toBe(percentile([10, 20, 30], 50));
  });

  it('returns the max at p100 and the min at p0', () => {
    expect(percentile([5, 1, 9], 100)).toBe(9);
    expect(percentile([5, 1, 9], 0)).toBe(1);
  });
});

describe('latencySummary', () => {
  it('summarises count, p50, p95 and max', () => {
    const summary = latencySummary([100, 200, 300, 400, 500]);
    expect(summary.count).toBe(5);
    expect(summary.p50).toBe(300);
    expect(summary.max).toBe(500);
  });

  it('reports nulls for an empty set instead of pretending it passed', () => {
    const summary = latencySummary([]);
    expect(summary).toEqual({ count: 0, p50: null, p95: null, max: null, mean: null });
  });
});

describe('characterErrorRate', () => {
  it('is 0 for an exact match', () => {
    expect(characterErrorRate('山田太郎', '山田太郎')).toBe(0);
  });

  it('counts substitutions, insertions and deletions over the reference length', () => {
    expect(characterErrorRate('山田', '山口')).toBeCloseTo(0.5);
    expect(characterErrorRate('山田', '山田です')).toBeCloseTo(1);
  });

  it('ignores whitespace and full-width/half-width spacing noise', () => {
    expect(characterErrorRate('山田 太郎', '山田　太郎')).toBe(0);
  });

  it('returns 1 when the reference is empty but the hypothesis is not', () => {
    expect(characterErrorRate('', 'あ')).toBe(1);
  });

  it('returns 0 when both are empty', () => {
    expect(characterErrorRate('', '')).toBe(0);
  });
});

const baseSession = (events: VoiceEvalEvent[], groundTruth: VoiceEvalSession['groundTruth']): VoiceEvalSession => ({
  schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
  sessionId: 's',
  locale: 'ja-JP',
  providers: { stt: 'mock', tts: 'mock', turn: 'mock' },
  events,
  groundTruth,
});

describe('computeLatencyMetrics', () => {
  it('derives every measurement origin defined by the common schema', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 180, turnIndex: 0, type: 'stt.partial', text: 'や', stable: false },
      { t: 290, turnIndex: 0, type: 'stt.partial', text: 'やまだ', stable: true },
      { t: 600, turnIndex: 0, type: 'speech.end' },
      { t: 700, turnIndex: 0, type: 'turn.committed', text: 'やまだ', trigger: 'silence' },
      { t: 720, turnIndex: 0, type: 'tts.request', text: '呼び出します' },
      { t: 820, turnIndex: 0, type: 'tts.first_byte' },
      { t: 900, turnIndex: 0, type: 'tts.playback_start' },
      { t: 1000, turnIndex: 0, type: 'vrm.viseme_applied', audioTimestampMs: 80 },
      { t: 1500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
    ];
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndOnsets: [] }));

    expect(metrics.audioOnsetToFirstPartial.p50).toBe(180);
    expect(metrics.audioOnsetToStablePartial.p50).toBe(290);
    expect(metrics.speechEndToTurnCommitted.p50).toBe(100);
    expect(metrics.turnCommittedToFirstAudio.p50).toBe(200);
    expect(metrics.ttsRequestToFirstByte.p50).toBe(100);
    // viseme は playback_start(900) + audioTimestampMs(80) = 980 に適用されるべきで、実測は 1000。
    expect(metrics.visemeSyncError.p50).toBe(20);
  });

  it('measures near-end onset to playback stop only for onsets during playback', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 420, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
      { t: 900, turnIndex: 1, type: 'audio.onset' },
    ];
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndOnsets: [] }));
    expect(metrics.nearEndOnsetToPlaybackStopped.count).toBe(1);
    expect(metrics.nearEndOnsetToPlaybackStopped.p50).toBe(120);
  });

  it('does not fabricate samples when a turn never produced audio', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 600, turnIndex: 0, type: 'speech.end' },
    ];
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndOnsets: [] }));
    expect(metrics.turnCommittedToFirstAudio.count).toBe(0);
    expect(metrics.turnCommittedToFirstAudio.p50).toBeNull();
  });
});

describe('computeSttMetrics', () => {
  it('reports CER separately from name/department exact match (AC: 精度を CER とは別に確認)', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 100, turnIndex: 0, type: 'stt.final', text: '山田さんお願いします' },
      { t: 200, turnIndex: 1, type: 'audio.onset' },
      { t: 300, turnIndex: 1, type: 'stt.final', text: '総務部です' },
    ];
    const metrics = computeSttMetrics(
      baseSession(events, {
        turns: [
          {
            turnIndex: 0,
            referenceTranscript: '山田さんお願いします',
            shouldCommit: true,
            endsWithFiller: false,
            expectedPersonNames: ['山田'],
          },
          {
            turnIndex: 1,
            referenceTranscript: '総務課です',
            shouldCommit: true,
            endsWithFiller: false,
            expectedDepartmentNames: ['総務課'],
          },
        ],
        nearEndOnsets: [],
      }),
    );

    expect(metrics.cer.count).toBe(2);
    expect(metrics.personNameExactMatchRate).toBe(1);
    expect(metrics.departmentNameExactMatchRate).toBe(0);
  });

  it('leaves rates null when the dataset carries no annotations for them', () => {
    const events: VoiceEvalEvent[] = [{ t: 0, turnIndex: 0, type: 'stt.final', text: 'a' }];
    const metrics = computeSttMetrics(
      baseSession(events, {
        turns: [{ turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false }],
        nearEndOnsets: [],
      }),
    );
    expect(metrics.personNameExactMatchRate).toBeNull();
    expect(metrics.departmentNameExactMatchRate).toBeNull();
  });
});

describe('computeTurnMetrics', () => {
  it('separates false commits, missed ends and filler-triggered false responses', () => {
    const events: VoiceEvalEvent[] = [
      // turn 0: 正しく終了した
      { t: 0, turnIndex: 0, type: 'speech.end' },
      { t: 100, turnIndex: 0, type: 'turn.committed', text: 'a', trigger: 'silence' },
      // turn 1: フィラーで切れてはいけないのに commit した（誤終了 かつ フィラー誤応答）
      { t: 200, turnIndex: 1, type: 'turn.committed', text: 'えーと', trigger: 'silence' },
      // turn 2: 終了すべきなのに commit しなかった（見逃し）
      { t: 300, turnIndex: 2, type: 'speech.end' },
    ];
    const metrics = computeTurnMetrics(
      baseSession(events, {
        turns: [
          { turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false },
          { turnIndex: 1, referenceTranscript: 'えーと', shouldCommit: false, endsWithFiller: true },
          { turnIndex: 2, referenceTranscript: 'c', shouldCommit: true, endsWithFiller: false },
        ],
        nearEndOnsets: [],
      }),
    );

    expect(metrics.falseCommitRate).toBe(1); // shouldCommit=false の 1 件中 1 件が commit
    expect(metrics.missedEndRate).toBe(0.5); // shouldCommit=true の 2 件中 1 件を見逃し
    expect(metrics.fillerFalseResponseRate).toBe(1);
  });

  it('is null-safe when the dataset has no negative turn examples', () => {
    const metrics = computeTurnMetrics(
      baseSession([{ t: 0, turnIndex: 0, type: 'turn.committed', text: 'a', trigger: 'silence' }], {
        turns: [{ turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false }],
        nearEndOnsets: [],
      }),
    );
    expect(metrics.falseCommitRate).toBeNull();
    expect(metrics.fillerFalseResponseRate).toBeNull();
    expect(metrics.missedEndRate).toBe(0);
  });
});

describe('computeBargeInMetrics', () => {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
    { t: 50, turnIndex: 0, type: 'tts.playback_start' },
    // onset#0: 真の割り込み → 停止した（正解）
    { t: 200, turnIndex: 0, type: 'audio.onset' },
    { t: 300, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
    { t: 400, turnIndex: 1, type: 'tts.request', text: 'b' },
    { t: 450, turnIndex: 1, type: 'tts.playback_start' },
    // onset#1: 相づち → 停止してしまった（誤停止）
    { t: 500, turnIndex: 1, type: 'audio.onset' },
    { t: 560, turnIndex: 1, type: 'tts.playback_stopped', reason: 'barge_in' },
    { t: 700, turnIndex: 2, type: 'tts.request', text: 'c' },
    { t: 750, turnIndex: 2, type: 'tts.playback_start' },
    // onset#2: 自己音声エコー → 停止しなかった（正解）
    { t: 800, turnIndex: 2, type: 'audio.onset' },
    { t: 1200, turnIndex: 2, type: 'tts.playback_stopped', reason: 'completed' },
    { t: 1300, turnIndex: 3, type: 'tts.request', text: 'd' },
    { t: 1350, turnIndex: 3, type: 'tts.playback_start' },
    // onset#3: 真の割り込み → 停止しなかった（検出漏れ）
    { t: 1400, turnIndex: 3, type: 'audio.onset' },
    { t: 1900, turnIndex: 3, type: 'tts.playback_stopped', reason: 'completed' },
  ];

  const metrics = computeBargeInMetrics(
    baseSession(events, {
      turns: [],
      nearEndOnsets: [
        { onsetIndex: 0, label: 'interruption' },
        { onsetIndex: 1, label: 'backchannel' },
        { onsetIndex: 2, label: 'echo' },
        { onsetIndex: 3, label: 'interruption' },
      ],
    }),
  );

  it('detects true interruptions at the recall the stream actually shows', () => {
    expect(metrics.trueInterruptionDetectionRate).toBe(0.5);
  });

  it('counts backchannel-induced false stops separately from echo-induced ones', () => {
    expect(metrics.backchannelFalseStopRate).toBe(1);
    expect(metrics.echoFalseStopRate).toBe(0);
  });

  it('reports an overall false stop rate across every non-interruption onset', () => {
    expect(metrics.falseStopRate).toBe(0.5);
  });

  it('leaves a rate null when the dataset has no onsets of that label', () => {
    const empty = computeBargeInMetrics(baseSession([], { turns: [], nearEndOnsets: [] }));
    expect(empty.trueInterruptionDetectionRate).toBeNull();
    expect(empty.backchannelFalseStopRate).toBeNull();
  });
});

describe('computeEntityMetrics', () => {
  it('computes Top1/Top3 inclusion plus recall and precision', () => {
    const events: VoiceEvalEvent[] = [
      {
        t: 10,
        turnIndex: 0,
        type: 'entity.resolved',
        query: '山田',
        candidates: [
          { id: 'staff-1', kind: 'staff', score: 0.9 },
          { id: 'staff-2', kind: 'staff', score: 0.7 },
          { id: 'staff-3', kind: 'staff', score: 0.5 },
        ],
      },
      {
        t: 20,
        turnIndex: 1,
        type: 'entity.resolved',
        query: '総務',
        candidates: [
          { id: 'dept-9', kind: 'department', score: 0.8 },
          { id: 'dept-1', kind: 'department', score: 0.6 },
          { id: 'dept-2', kind: 'department', score: 0.4 },
        ],
      },
    ];
    const metrics = computeEntityMetrics(
      baseSession(events, {
        turns: [
          { turnIndex: 0, referenceTranscript: '山田', shouldCommit: true, endsWithFiller: false, expectedEntityIds: ['staff-1'] },
          { turnIndex: 1, referenceTranscript: '総務', shouldCommit: true, endsWithFiller: false, expectedEntityIds: ['dept-1'] },
        ],
        nearEndOnsets: [],
      }),
    );

    expect(metrics.top1Rate).toBe(0.5);
    expect(metrics.top3Rate).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBeCloseTo(2 / 6);
  });

  it('counts a turn with no resolution event as a Top1 and Top3 miss', () => {
    const metrics = computeEntityMetrics(
      baseSession([], {
        turns: [
          { turnIndex: 0, referenceTranscript: '山田', shouldCommit: true, endsWithFiller: false, expectedEntityIds: ['staff-1'] },
        ],
        nearEndOnsets: [],
      }),
    );
    expect(metrics.top1Rate).toBe(0);
    expect(metrics.top3Rate).toBe(0);
    expect(metrics.recall).toBe(0);
  });
});

describe('computeSessionMetrics', () => {
  it('aggregates every metric family under one provider-tagged record', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 120, turnIndex: 0, type: 'stt.partial', text: 'や', stable: true },
      { t: 400, turnIndex: 0, type: 'speech.end' },
      { t: 450, turnIndex: 0, type: 'stt.final', text: '山田' },
      { t: 500, turnIndex: 0, type: 'turn.committed', text: '山田', trigger: 'silence' },
      { t: 510, turnIndex: 0, type: 'tts.request', text: 'ok' },
      { t: 600, turnIndex: 0, type: 'tts.first_byte' },
      { t: 700, turnIndex: 0, type: 'tts.playback_start' },
      { t: 1200, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
    ];
    const metrics = computeSessionMetrics(
      baseSession(events, {
        turns: [{ turnIndex: 0, referenceTranscript: '山田', shouldCommit: true, endsWithFiller: false }],
        nearEndOnsets: [],
      }),
    );

    expect(metrics.sessionId).toBe('s');
    expect(metrics.providers.stt).toBe('mock');
    expect(metrics.turn.missedEndRate).toBe(0);
    expect(metrics.latency.turnCommittedToFirstAudio.p50).toBe(200);
    expect(metrics.stt.cer.count).toBe(1);
  });
});
