import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import { computeSessionMetrics, computeSuiteMetrics } from './evaluation-metrics';
import { VOICE_EVAL_PROFILES, evaluateAgainstSlo, parseVoiceEvalProfile } from './evaluation-thresholds';

function suiteOf(sessions: VoiceEvalSession[]) {
  return computeSuiteMetrics(sessions.map(computeSessionMetrics));
}

function fastSession(): VoiceEvalSession {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'audio.onset' },
    { t: 200, turnIndex: 0, type: 'stt.partial', text: 'や', stable: true },
    { t: 400, turnIndex: 0, type: 'speech.end' },
    { t: 450, turnIndex: 0, type: 'turn.committed', text: '山田', trigger: 'silence' },
    { t: 460, turnIndex: 0, type: 'tts.request', text: 'ok' },
    { t: 520, turnIndex: 0, type: 'tts.first_byte' },
    { t: 700, turnIndex: 0, type: 'tts.playback_start' },
    { t: 1500, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
  ];
  return {
    schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
    sessionId: 'fast',
    locale: 'ja-JP',
    providers: { stt: 'mock', tts: 'mock', turn: 'mock' },
    events,
    groundTruth: {
      turns: [
        {
          turnIndex: 0,
          referenceTranscript: '山田',
          shouldCommit: true,
          endsWithFiller: false,
          utteranceKind: 'short_answer',
        },
      ],
      nearEndOnsets: [],
    },
  };
}

function slowSession(): VoiceEvalSession {
  const s = fastSession();
  return {
    ...s,
    sessionId: 'slow',
    events: s.events.map((e) => (e.type === 'stt.partial' ? { ...e, t: 1200 } : e)) as VoiceEvalEvent[],
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

  it('relaxes the ci profile relative to uat (合成 fixture のノイズで赤にしない)', () => {
    expect(VOICE_EVAL_PROFILES.ci.thresholds.stablePartialP50Ms).toBeGreaterThanOrEqual(
      VOICE_EVAL_PROFILES.uat.thresholds.stablePartialP50Ms,
    );
  });
});

describe('evaluateAgainstSlo', () => {
  it('passes a run that meets every measurable threshold', () => {
    const result = evaluateAgainstSlo(suiteOf([fastSession()]), VOICE_EVAL_PROFILES.uat.thresholds);
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('flags a stable-partial regression with the observed and allowed values', () => {
    const result = evaluateAgainstSlo(suiteOf([slowSession()]), VOICE_EVAL_PROFILES.uat.thresholds);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.metric === 'stablePartialP50Ms');
    expect(violation?.observed).toBe(1200);
    expect(violation?.allowed).toBe(300);
  });

  it('records undecidable metrics as skipped rather than passing them silently', () => {
    const result = evaluateAgainstSlo(suiteOf([fastSession()]), VOICE_EVAL_PROFILES.uat.thresholds);
    expect(result.skipped.map((s) => s.metric)).toContain('bargeInStopP50Ms');
    expect(result.skipped.map((s) => s.metric)).toContain('minEntityTop3Rate');
  });

  it('fails when a required metric is missing under strict mode (計測欠落を緑にしない)', () => {
    const result = evaluateAgainstSlo(suiteOf([fastSession()]), VOICE_EVAL_PROFILES.uat.thresholds, { strict: true });
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.reason.includes('計測不能'))).toBe(true);
  });

  it('flags a false-stop rate above the allowed ceiling', () => {
    const suite = suiteOf([fastSession()]);
    const withBargeIn = {
      ...suite,
      bargeIn: { ...suite.bargeIn, falseStopRate: 0.1, trueInterruptionDetectionRate: 1 },
    };
    const result = evaluateAgainstSlo(withBargeIn, VOICE_EVAL_PROFILES.uat.thresholds);
    expect(result.violations.map((v) => v.metric)).toContain('maxFalseStopRate');
  });

  it('flags an entity Top3 rate below the floor', () => {
    const suite = suiteOf([fastSession()]);
    const withEntity = { ...suite, entity: { ...suite.entity, top3Rate: 0.8 } };
    const result = evaluateAgainstSlo(withEntity, VOICE_EVAL_PROFILES.uat.thresholds);
    const violation = result.violations.find((v) => v.metric === 'minEntityTop3Rate');
    expect(violation?.observed).toBe(0.8);
  });
});
