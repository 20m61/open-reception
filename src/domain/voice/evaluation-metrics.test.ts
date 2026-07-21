import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import {
  attributeBargeInStops,
  characterErrorRate,
  computeBargeInMetrics,
  computeEntityMetrics,
  computeLatencyMetrics,
  computeReliabilityMetrics,
  computeSessionMetrics,
  computeSttMetrics,
  computeSuiteMetrics,
  computeTurnMetrics,
  latencySummary,
  matchNearEnd,
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

  it('clamps an out-of-range percentile instead of returning 0', () => {
    expect(percentile([5, 1, 9], 150)).toBe(9);
    expect(percentile([5, 1, 9], -10)).toBe(1);
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
    expect(latencySummary([])).toEqual({ count: 0, p50: null, p95: null, max: null, mean: null });
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
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));

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
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));
    expect(metrics.nearEndOnsetToPlaybackStopped.count).toBe(1);
    expect(metrics.nearEndOnsetToPlaybackStopped.p50).toBe(120);
  });

  it('does not credit a later onset with a stop it did not cause (楽観バイアスを作らない)', () => {
    // 300ms の onset が停止を起こし、その後 500ms の相づちが再生終了直前に入る。
    // 後者にも遅延サンプルを積むと (520-500)=20ms が p50 を押し下げてしまう。
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 500, turnIndex: 0, type: 'audio.onset' },
      { t: 520, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
    ];
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));
    expect(metrics.nearEndOnsetToPlaybackStopped.count).toBe(1);
    expect(metrics.nearEndOnsetToPlaybackStopped.p50).toBe(220);
  });

  it('does not fabricate samples when a turn never produced audio', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'audio.onset' },
      { t: 600, turnIndex: 0, type: 'speech.end' },
    ];
    const metrics = computeLatencyMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));
    expect(metrics.turnCommittedToFirstAudio.count).toBe(0);
    expect(metrics.turnCommittedToFirstAudio.p50).toBeNull();
  });
});

describe('attributeBargeInStops', () => {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
    { t: 100, turnIndex: 0, type: 'tts.playback_start' },
    { t: 300, turnIndex: 0, type: 'audio.onset' },
    { t: 500, turnIndex: 0, type: 'audio.onset' },
    { t: 520, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
  ];

  it('ignores an onset too close to the stop to have caused it (判断が飛行中の相づち)', () => {
    // 300ms の割り込みが停止を起こし、その 20ms 前に相づちが入る。停止まで 20ms では間に合わない。
    const attributions = attributeBargeInStops(events);
    expect(attributions.map((a) => a.stopped)).toEqual([true, false]);
    expect(attributions[0]?.stopLatencyMs).toBe(220);
    expect(attributions[1]?.stopLatencyMs).toBeNull();
  });

  it('credits the later onset when both are far enough before the stop (相づち → 本当の割り込み)', () => {
    // 相づちの 400ms 後に本当の割り込みが来て停止した系列。「区間の最初」を採ると相づちが原因にされる。
    const consecutive: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 700, turnIndex: 0, type: 'audio.onset' },
      { t: 820, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
    ];
    const attributions = attributeBargeInStops(consecutive);
    expect(attributions.map((a) => a.stopped)).toEqual([false, true]);
    expect(attributions[1]?.stopLatencyMs).toBe(120);
  });

  it('credits nothing when the playback finished naturally', () => {
    const natural: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 900, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
    ];
    expect(attributeBargeInStops(natural).map((a) => a.stopped)).toEqual([false]);
  });
});

describe('matchNearEnd', () => {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
    { t: 100, turnIndex: 0, type: 'tts.playback_start' },
    { t: 300, turnIndex: 0, type: 'audio.onset' },
    { t: 420, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
  ];

  it('matches a stimulus to the observation inside its tolerance window', () => {
    const { matches, spuriousObservations } = matchNearEnd(
      baseSession(events, {
        turns: [],
        nearEndStimuli: [{ id: 's1', atMs: 320, toleranceMs: 100, label: 'interruption' }],
      }),
    );
    expect(matches[0]?.observation?.t).toBe(300);
    expect(matches[0]?.stopped).toBe(true);
    expect(spuriousObservations).toEqual([]);
  });

  it('reports a stimulus outside every tolerance window as undetected, not as an error', () => {
    // VAD が onset を取りこぼしたケース。以前はラベルがずれるか fatal になっていた。
    const { matches, spuriousObservations } = matchNearEnd(
      baseSession(events, {
        turns: [],
        nearEndStimuli: [{ id: 's1', atMs: 5000, toleranceMs: 100, label: 'interruption' }],
      }),
    );
    expect(matches[0]?.observation).toBeNull();
    expect(matches[0]?.stopped).toBe(false);
    expect(spuriousObservations).toHaveLength(1);
  });

  it('never assigns one observation to two stimuli', () => {
    const { matches } = matchNearEnd(
      baseSession(events, {
        turns: [],
        nearEndStimuli: [
          { id: 'a', atMs: 300, toleranceMs: 200, label: 'backchannel' },
          { id: 'b', atMs: 310, toleranceMs: 200, label: 'interruption' },
        ],
      }),
    );
    expect(matches.filter((m) => m.observation !== null)).toHaveLength(1);
  });
});

describe('computeSttMetrics', () => {
  it('reports CER separately from name/department match (AC: 精度を CER とは別に確認)', () => {
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
        nearEndStimuli: [],
      }),
    );

    expect(metrics.cer.count).toBe(2);
    expect(metrics.personNameExactMatchRate).toBe(1);
    expect(metrics.departmentNameExactMatchRate).toBe(0);
  });

  it('computes corpus CER from pooled edit distance, not the mean of per-utterance rates', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'stt.final', text: 'X' }, // 1 文字中 1 誤り
      { t: 100, turnIndex: 1, type: 'stt.final', text: 'あいうえおかきくけこ' }, // 10 文字中 0 誤り
    ];
    const metrics = computeSttMetrics(
      baseSession(events, {
        turns: [
          { turnIndex: 0, referenceTranscript: 'あ', shouldCommit: true, endsWithFiller: false },
          { turnIndex: 1, referenceTranscript: 'あいうえおかきくけこ', shouldCommit: true, endsWithFiller: false },
        ],
        nearEndStimuli: [],
      }),
    );
    // 発話ごとの CER の平均なら 0.5。コーパス CER は 1/11。
    expect(metrics.corpusCer).toBeCloseTo(1 / 11);
    expect(metrics.cer.mean).toBeCloseTo(0.5);
  });

  it('leaves rates null when the dataset carries no annotations for them', () => {
    const events: VoiceEvalEvent[] = [{ t: 0, turnIndex: 0, type: 'stt.final', text: 'a' }];
    const metrics = computeSttMetrics(
      baseSession(events, {
        turns: [{ turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false }],
        nearEndStimuli: [],
      }),
    );
    expect(metrics.personNameExactMatchRate).toBeNull();
    expect(metrics.departmentNameExactMatchRate).toBeNull();
  });
});

describe('computeTurnMetrics', () => {
  it('separates false commits, missed ends and filler-triggered false responses', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'speech.end' },
      { t: 100, turnIndex: 0, type: 'turn.committed', text: 'a', trigger: 'silence' },
      { t: 200, turnIndex: 1, type: 'turn.committed', text: 'えーと', trigger: 'silence' },
      { t: 300, turnIndex: 2, type: 'speech.end' },
    ];
    const metrics = computeTurnMetrics(
      baseSession(events, {
        turns: [
          { turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false },
          { turnIndex: 1, referenceTranscript: 'えーと', shouldCommit: false, endsWithFiller: true },
          { turnIndex: 2, referenceTranscript: 'c', shouldCommit: true, endsWithFiller: false },
        ],
        nearEndStimuli: [],
      }),
    );

    expect(metrics.falseCommitRate).toBe(1);
    expect(metrics.missedEndRate).toBe(0.5);
    expect(metrics.fillerFalseResponseRate).toBe(1);
  });

  it('is null-safe when the dataset has no negative turn examples', () => {
    const metrics = computeTurnMetrics(
      baseSession([{ t: 0, turnIndex: 0, type: 'turn.committed', text: 'a', trigger: 'silence' }], {
        turns: [{ turnIndex: 0, referenceTranscript: 'a', shouldCommit: true, endsWithFiller: false }],
        nearEndStimuli: [],
      }),
    );
    expect(metrics.falseCommitRate).toBeNull();
    expect(metrics.fillerFalseResponseRate).toBeNull();
    expect(metrics.missedEndRate).toBe(0);
  });
});

describe('computeBargeInMetrics', () => {
  // 4 回の応答再生に、それぞれ 1 つの近端発話が入る。
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
    { t: 50, turnIndex: 0, type: 'tts.playback_start' },
    { t: 200, turnIndex: 0, type: 'audio.onset' }, // 真の割り込み → 停止（正解）
    { t: 300, turnIndex: 0, type: 'tts.playback_stopped', reason: 'barge_in' },
    { t: 400, turnIndex: 1, type: 'tts.request', text: 'b' },
    { t: 450, turnIndex: 1, type: 'tts.playback_start' },
    { t: 500, turnIndex: 1, type: 'audio.onset' }, // 相づち → 停止（誤停止）
    { t: 560, turnIndex: 1, type: 'tts.playback_stopped', reason: 'barge_in' },
    { t: 700, turnIndex: 2, type: 'tts.request', text: 'c' },
    { t: 750, turnIndex: 2, type: 'tts.playback_start' },
    { t: 800, turnIndex: 2, type: 'audio.onset' }, // エコー → 停止せず（正解）
    { t: 1200, turnIndex: 2, type: 'tts.playback_stopped', reason: 'completed' },
    { t: 1300, turnIndex: 3, type: 'tts.request', text: 'd' },
    { t: 1350, turnIndex: 3, type: 'tts.playback_start' },
    { t: 1400, turnIndex: 3, type: 'audio.onset' }, // 真の割り込み → 停止せず（検出漏れ）
    { t: 1900, turnIndex: 3, type: 'tts.playback_stopped', reason: 'completed' },
  ];

  const metrics = computeBargeInMetrics(
    baseSession(events, {
      turns: [],
      nearEndStimuli: [
        { id: 'i1', atMs: 200, toleranceMs: 50, label: 'interruption' },
        { id: 'b1', atMs: 500, toleranceMs: 50, label: 'backchannel' },
        { id: 'e1', atMs: 800, toleranceMs: 50, label: 'echo' },
        { id: 'i2', atMs: 1400, toleranceMs: 50, label: 'interruption' },
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

  it('reports an overall false stop rate across every non-interruption stimulus', () => {
    expect(metrics.falseStopRate).toBe(0.5);
  });

  it('reports full onset detection when every stimulus was observed', () => {
    expect(metrics.nearEndOnsetDetectionRate).toBe(1);
    expect(metrics.spuriousNearEndOnsetCount).toBe(0);
  });

  it('counts an undetected stimulus as a detection miss rather than dropping it', () => {
    const partial = computeBargeInMetrics(
      baseSession(events, {
        turns: [],
        nearEndStimuli: [
          { id: 'i1', atMs: 200, toleranceMs: 50, label: 'interruption' },
          { id: 'ghost', atMs: 9000, toleranceMs: 50, label: 'interruption' },
        ],
      }),
    );
    expect(partial.nearEndOnsetDetectionRate).toBe(0.5);
    expect(partial.trueInterruptionDetectionRate).toBe(0.5);
  });

  it('leaves a rate null when the dataset has no stimuli of that label', () => {
    const empty = computeBargeInMetrics(baseSession([], { turns: [], nearEndStimuli: [] }));
    expect(empty.trueInterruptionDetectionRate).toBeNull();
    expect(empty.backchannelFalseStopRate).toBeNull();
    expect(empty.nearEndOnsetDetectionRate).toBeNull();
  });

  it('treats a playback that never stops as an undetected interruption, not as zero onsets', () => {
    const stuck: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'tts.request', text: 'a' },
      { t: 100, turnIndex: 0, type: 'tts.playback_start' },
      { t: 300, turnIndex: 0, type: 'audio.onset' },
      { t: 2000, turnIndex: 0, type: 'speech.end' },
    ];
    const result = computeBargeInMetrics(
      baseSession(stuck, {
        turns: [],
        nearEndStimuli: [{ id: 'i', atMs: 300, toleranceMs: 50, label: 'interruption' }],
      }),
    );
    expect(result.nearEndOnsetDetectionRate).toBe(1);
    expect(result.trueInterruptionDetectionRate).toBe(0);
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
          {
            turnIndex: 0,
            referenceTranscript: '山田',
            shouldCommit: true,
            endsWithFiller: false,
            expectedEntityIds: ['staff-1'],
          },
          {
            turnIndex: 1,
            referenceTranscript: '総務',
            shouldCommit: true,
            endsWithFiller: false,
            expectedEntityIds: ['dept-1'],
          },
        ],
        nearEndStimuli: [],
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
          {
            turnIndex: 0,
            referenceTranscript: '山田',
            shouldCommit: true,
            endsWithFiller: false,
            expectedEntityIds: ['staff-1'],
          },
        ],
        nearEndStimuli: [],
      }),
    );
    expect(metrics.top1Rate).toBe(0);
    expect(metrics.top3Rate).toBe(0);
    expect(metrics.recall).toBe(0);
  });
});

describe('computeReliabilityMetrics', () => {
  it('counts an aborted session, its errors and reconnects', () => {
    const events: VoiceEvalEvent[] = [
      { t: 0, turnIndex: 0, type: 'transport.connected' },
      { t: 10, turnIndex: 0, type: 'transport.stats', droppedPackets: 1, jitterMs: 30 },
      { t: 20, turnIndex: 0, type: 'transport.reconnecting', attempt: 1 },
      { t: 30, turnIndex: 0, type: 'error', stage: 'stt', code: 'timeout' },
      { t: 40, turnIndex: 0, type: 'session.aborted', stage: 'transport', code: 'closed' },
    ];
    const metrics = computeReliabilityMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));
    expect(metrics.abortedSessionRate).toBe(1);
    expect(metrics.errorEventsPerSession).toBe(1);
    expect(metrics.reconnectsPerSession).toBe(1);
    expect(metrics.jitterMs.max).toBe(30);
  });

  it('reports a clean session as zero aborted', () => {
    const metrics = computeReliabilityMetrics(
      baseSession([{ t: 0, turnIndex: 0, type: 'transport.connected' }], { turns: [], nearEndStimuli: [] }),
    );
    expect(metrics.abortedSessionRate).toBe(0);
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
        nearEndStimuli: [],
      }),
    );

    expect(metrics.sessionId).toBe('s');
    expect(metrics.providers.stt).toBe('mock');
    expect(metrics.turn.missedEndRate).toBe(0);
    expect(metrics.latency.turnCommittedToFirstAudio.p50).toBe(200);
    expect(metrics.stt.cer.count).toBe(1);
    expect(metrics.reliability.abortedSessionRate).toBe(0);
  });
});

describe('computeSuiteMetrics', () => {
  /** `turns` 件のターンを持ち、`missed` 件を確定し損ねたセッションを作る。 */
  function sessionWithTurns(id: string, turns: number, missed: number) {
    const events: VoiceEvalEvent[] = [];
    const groundTruth: VoiceEvalSession['groundTruth'] = { turns: [], nearEndStimuli: [] };
    for (let i = 0; i < turns; i += 1) {
      const base = i * 1000;
      events.push({ t: base, turnIndex: i, type: 'speech.end' });
      if (i >= missed) events.push({ t: base + 50, turnIndex: i, type: 'turn.committed', text: 'x', trigger: 'silence' });
      groundTruth.turns.push({ turnIndex: i, referenceTranscript: 'x', shouldCommit: true, endsWithFiller: false });
    }
    return computeSessionMetrics(baseSession(events, groundTruth));
  }

  it('pools numerators and denominators instead of averaging per-session rates', () => {
    // 1 ターン中 1 件見逃し (rate 1.0) と、9 ターン中 0 件見逃し (rate 0.0)。
    // 率の平均なら 0.5、正しい pooling なら 1/10 = 0.1。
    const small = sessionWithTurns('small', 1, 1);
    const large = sessionWithTurns('large', 9, 0);

    expect(small.turn.missedEndRate).toBe(1);
    expect(large.turn.missedEndRate).toBe(0);

    const suite = computeSuiteMetrics([small, large]);
    expect(suite.turn.missedEndRate).toBeCloseTo(0.1);
    expect(suite.sessionCount).toBe(2);
  });

  it('pools latency samples across sessions rather than percentiles of percentiles', () => {
    const build = (id: string, values: number[]) => {
      const events: VoiceEvalEvent[] = [];
      values.forEach((value, i) => {
        const base = i * 10_000;
        events.push({ t: base, turnIndex: i, type: 'audio.onset' });
        events.push({ t: base + value, turnIndex: i, type: 'stt.partial', text: 'x', stable: true });
      });
      return computeSessionMetrics(baseSession(events, { turns: [], nearEndStimuli: [] }));
    };

    const suite = computeSuiteMetrics([build('a', [100]), build('b', [200, 300, 400])]);
    expect(suite.latency.audioOnsetToStablePartial.count).toBe(4);
    expect(suite.latency.audioOnsetToStablePartial.p50).toBe(250);
  });

  it('pools corpus CER by total edit distance across sessions', () => {
    const build = (reference: string, hypothesis: string) =>
      computeSessionMetrics(
        baseSession([{ t: 0, turnIndex: 0, type: 'stt.final', text: hypothesis }], {
          turns: [{ turnIndex: 0, referenceTranscript: reference, shouldCommit: true, endsWithFiller: false }],
          nearEndStimuli: [],
        }),
      );

    const suite = computeSuiteMetrics([build('あ', 'X'), build('あいうえおかきくけこ', 'あいうえおかきくけこ')]);
    expect(suite.stt.corpusCer).toBeCloseTo(1 / 11);
  });

  it('reports an empty suite as undecidable rather than perfect', () => {
    const suite = computeSuiteMetrics([]);
    expect(suite.turn.missedEndRate).toBeNull();
    expect(suite.stt.corpusCer).toBeNull();
    expect(suite.bargeIn.trueInterruptionDetectionRate).toBeNull();
  });
});
