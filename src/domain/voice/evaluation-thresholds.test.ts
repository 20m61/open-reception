import { describe, expect, it } from 'vitest';

import type { LatencySummary, VoiceEvalSuiteMetrics } from './evaluation-metrics';
import { VOICE_EVAL_PROFILES, evaluateAgainstSlo, parseVoiceEvalProfile } from './evaluation-thresholds';

function summary(value: number | null): LatencySummary {
  return value === null
    ? { count: 0, p50: null, p95: null, max: null, mean: null }
    : { count: 3, p50: value, p95: value, max: value, mean: value };
}

/** 全指標が計測でき、実機 SLO を満たすスイート。ここから 1 つずつ壊して判定を確かめる。 */
function healthySuite(): VoiceEvalSuiteMetrics {
  return {
    sessionCount: 5,
    latency: {
      audioOnsetToFirstPartial: summary(120),
      audioOnsetToStablePartial: summary(250),
      speechEndToTurnCommitted: summary(100),
      turnCommittedToFirstAudio: summary(200),
      ttsRequestToFirstByte: summary(90),
      speechEndToFirstAudio: summary(320),
      speechEndToFirstAudioShortAnswer: summary(320),
      speechEndToFirstAudioFreeForm: summary(700),
      nearEndOnsetToPlaybackStopped: summary(120),
      visemeSyncError: summary(15),
    },
    stt: {
      cer: summary(0.01),
      corpusCer: 0.01,
      personNameExactMatchRate: 1,
      departmentNameExactMatchRate: 1,
    },
    turn: { falseCommitRate: 0, missedEndRate: 0, fillerFalseResponseRate: 0 },
    bargeIn: {
      trueInterruptionDetectionRate: 1,
      backchannelFalseStopRate: 0,
      echoFalseStopRate: 0,
      falseStopRate: 0,
      nearEndOnsetDetectionRate: 1,
      spuriousNearEndOnsetCount: 0,
    },
    entity: { top1Rate: 1, top3Rate: 1, recall: 1, precision: 0.5 },
    reliability: {
      abortedSessionRate: 0,
      errorEventsPerSession: 0,
      reconnectsPerSession: 0,
      jitterMs: summary(10),
    },
  };
}

describe('parseVoiceEvalProfile', () => {
  it('defaults to the lightweight ci profile for unknown input (誤って重いセットを回さない)', () => {
    expect(parseVoiceEvalProfile(undefined).name).toBe('ci');
    expect(parseVoiceEvalProfile('nonsense').name).toBe('ci');
  });

  it('resolves the full on-device UAT profile by name', () => {
    expect(parseVoiceEvalProfile('uat').name).toBe('uat');
  });

  it('holds the SLO values published in issue #365 for the uat profile', () => {
    const uat = VOICE_EVAL_PROFILES.uat;
    expect(uat.thresholds.stablePartialP50Ms).toBe(300);
    expect(uat.thresholds.bargeInStopP50Ms).toBe(150);
    expect(uat.thresholds.bargeInStopP95Ms).toBe(300);
    expect(uat.thresholds.shortAnswerFirstAudioP50Ms).toBe(500);
    expect(uat.thresholds.freeFormFirstAudioP50Ms).toBe(900);
    expect(uat.thresholds.maxFalseStopRate).toBe(0.02);
    expect(uat.thresholds.maxFalseCommitRate).toBe(0.03);
    expect(uat.thresholds.minEntityTop3Rate).toBe(0.99);
  });

  it('treats calibration mistakes as violations of the measurable set (計測欠落を緑にしない)', () => {
    expect(VOICE_EVAL_PROFILES.uat.strict).toBe(true);
    expect(VOICE_EVAL_PROFILES.ci.strict).toBe(false);
  });

  it('relaxes the ci profile relative to uat (合成 fixture のノイズで赤にしない)', () => {
    expect(VOICE_EVAL_PROFILES.ci.thresholds.stablePartialP50Ms).toBeGreaterThanOrEqual(
      VOICE_EVAL_PROFILES.uat.thresholds.stablePartialP50Ms,
    );
    expect(VOICE_EVAL_PROFILES.ci.thresholds.minTrueInterruptionDetectionRate).toBeLessThanOrEqual(
      VOICE_EVAL_PROFILES.uat.thresholds.minTrueInterruptionDetectionRate,
    );
  });

  it('pairs every false-positive ceiling with a false-negative floor', () => {
    // 非対称な SLO セットは「何もしない provider」を最も安い緑にしてしまう。
    const t = VOICE_EVAL_PROFILES.uat.thresholds;
    expect(t.maxFalseStopRate).toBeDefined();
    expect(t.minTrueInterruptionDetectionRate).toBeDefined();
    expect(t.maxFalseCommitRate).toBeDefined();
    expect(t.maxMissedEndRate).toBeDefined();
  });
});

describe('evaluateAgainstSlo', () => {
  const uat = VOICE_EVAL_PROFILES.uat.thresholds;

  it('passes a run that meets every threshold', () => {
    const result = evaluateAgainstSlo(healthySuite(), uat, { strict: true });
    expect(result.violations).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('flags a stable-partial regression with the observed and allowed values', () => {
    const suite = healthySuite();
    suite.latency.audioOnsetToStablePartial = summary(1200);
    const result = evaluateAgainstSlo(suite, uat);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.metric === 'stablePartialP50Ms');
    expect(violation?.observed).toBe(1200);
    expect(violation?.allowed).toBe(300);
  });

  it('records undecidable metrics as skipped when not strict', () => {
    const suite = healthySuite();
    suite.latency.nearEndOnsetToPlaybackStopped = summary(null);
    const result = evaluateAgainstSlo(suite, uat, { strict: false });
    expect(result.skipped.map((s) => s.metric)).toContain('bargeInStopP50Ms');
    expect(result.passed).toBe(true);
  });

  it('fails when a required metric is missing under strict mode (計測欠落を緑にしない)', () => {
    const suite = healthySuite();
    suite.latency.nearEndOnsetToPlaybackStopped = summary(null);
    const result = evaluateAgainstSlo(suite, uat, { strict: true });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('計測不能'))).toBe(true);
  });

  it('fails a suite with no measurable events at all under strict mode', () => {
    // 「1 件も計測できなかった」を最も厳しいプロファイルが緑にしてはいけない。
    const empty: VoiceEvalSuiteMetrics = {
      ...healthySuite(),
      latency: Object.fromEntries(
        Object.keys(healthySuite().latency).map((key) => [key, summary(null)]),
      ) as VoiceEvalSuiteMetrics['latency'],
      stt: { cer: summary(null), corpusCer: null, personNameExactMatchRate: null, departmentNameExactMatchRate: null },
      turn: { falseCommitRate: null, missedEndRate: null, fillerFalseResponseRate: null },
      bargeIn: {
        trueInterruptionDetectionRate: null,
        backchannelFalseStopRate: null,
        echoFalseStopRate: null,
        falseStopRate: null,
        nearEndOnsetDetectionRate: null,
        spuriousNearEndOnsetCount: 0,
      },
      entity: { top1Rate: null, top3Rate: null, recall: null, precision: null },
      reliability: {
        abortedSessionRate: null,
        errorEventsPerSession: null,
        reconnectsPerSession: null,
        jitterMs: summary(null),
      },
    };
    expect(evaluateAgainstSlo(empty, uat, { strict: true }).passed).toBe(false);
  });

  it('flags a false-stop rate above the allowed ceiling', () => {
    const suite = healthySuite();
    suite.bargeIn.falseStopRate = 0.1;
    expect(evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric)).toContain('maxFalseStopRate');
  });

  it('flags a provider that never stops for a real interruption (何もしない provider を緑にしない)', () => {
    const suite = healthySuite();
    suite.bargeIn.trueInterruptionDetectionRate = 0;
    suite.bargeIn.falseStopRate = 0; // 誤停止はゼロ。以前はこれだけで緑だった。
    const violations = evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric);
    expect(violations).toContain('minTrueInterruptionDetectionRate');
  });

  it('flags a provider that never commits a turn', () => {
    const suite = healthySuite();
    suite.turn.missedEndRate = 1;
    suite.turn.falseCommitRate = 0;
    expect(evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric)).toContain('maxMissedEndRate');
  });

  it('flags a provider that fails to detect near-end speech at all', () => {
    const suite = healthySuite();
    suite.bargeIn.nearEndOnsetDetectionRate = 0.2;
    expect(evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric)).toContain('minNearEndOnsetDetectionRate');
  });

  it('flags corpus CER and name accuracy regressions', () => {
    const suite = healthySuite();
    suite.stt.corpusCer = 0.4;
    suite.stt.personNameExactMatchRate = 0.5;
    suite.stt.departmentNameExactMatchRate = 0.5;
    const violations = evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric);
    expect(violations).toContain('maxCorpusCer');
    expect(violations).toContain('minPersonNameExactMatchRate');
    expect(violations).toContain('minDepartmentNameExactMatchRate');
  });

  it('flags a viseme sync regression', () => {
    const suite = healthySuite();
    suite.latency.visemeSyncError = summary(200);
    expect(evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric)).toContain('visemeSyncErrorP50Ms');
  });

  it('flags aborted sessions', () => {
    const suite = healthySuite();
    suite.reliability.abortedSessionRate = 0.5;
    expect(evaluateAgainstSlo(suite, uat).violations.map((v) => v.metric)).toContain('maxAbortedSessionRate');
  });

  it('flags an entity Top3 rate below the floor', () => {
    const suite = healthySuite();
    suite.entity.top3Rate = 0.8;
    const violation = evaluateAgainstSlo(suite, uat).violations.find((v) => v.metric === 'minEntityTop3Rate');
    expect(violation?.observed).toBe(0.8);
  });
});
