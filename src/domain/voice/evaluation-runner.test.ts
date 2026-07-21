import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import { VOICE_EVAL_PROFILES } from './evaluation-thresholds';
import {
  createReplayProvider,
  runVoiceEvalSuite,
  type VoiceEvalProvider,
  type VoiceEvalScenario,
} from './evaluation-runner';

const scenario: VoiceEvalScenario = {
  id: 'sc-1',
  locale: 'ja-JP',
  description: '担当者名の短答',
  tags: ['person-name', 'short-answer'],
  input: { kind: 'synthetic', utterances: [{ turnIndex: 0, text: '山田さんをお願いします' }] },
  groundTruth: {
    turns: [
      {
        turnIndex: 0,
        referenceTranscript: '山田さんをお願いします',
        shouldCommit: true,
        endsWithFiller: false,
        utteranceKind: 'short_answer',
        expectedPersonNames: ['山田'],
        expectedEntityIds: ['staff-1'],
      },
    ],
    nearEndStimuli: [],
  },
};

/** provider は時刻順にイベントを出す契約なので、fixture 側でも並べ替えてから返す。 */
function eventsFor(stablePartialAt: number): VoiceEvalEvent[] {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'audio.onset' },
    { t: stablePartialAt, turnIndex: 0, type: 'stt.partial', text: 'やまだ', stable: true },
    { t: 500, turnIndex: 0, type: 'speech.end' },
    { t: 540, turnIndex: 0, type: 'stt.final', text: '山田さんをお願いします' },
    { t: 560, turnIndex: 0, type: 'turn.committed', text: '山田さんをお願いします', trigger: 'silence' },
    {
      t: 570,
      turnIndex: 0,
      type: 'entity.resolved',
      query: '山田',
      candidates: [{ id: 'staff-1', kind: 'staff', score: 0.9 }],
    },
    { t: 580, turnIndex: 0, type: 'tts.request', text: '山田を呼び出します' },
    { t: 650, turnIndex: 0, type: 'tts.first_byte' },
    { t: 800, turnIndex: 0, type: 'tts.playback_start' },
    { t: 1800, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
  ];
  return [...events].sort((a, b) => a.t - b.t);
}

function providerFor(id: string, stablePartialAt: number): VoiceEvalProvider {
  return createReplayProvider({
    id,
    providers: { stt: id, tts: 'mock-tts', turn: 'mock-turn' },
    sessionsByScenario: { 'sc-1': eventsFor(stablePartialAt) },
  });
}

// 合成 fixture は全指標を埋めないため、runner の挙動確認には非 strict の ci プロファイルを使う。
const profile = VOICE_EVAL_PROFILES.ci;

describe('createReplayProvider', () => {
  it('replays a recorded stream as a schema-valid session', async () => {
    const session = await providerFor('p', 150).run(scenario);
    expect(session.schemaVersion).toBe(VOICE_EVAL_SCHEMA_VERSION);
    expect(session.sessionId).toBe('p/sc-1');
    expect(session.groundTruth).toEqual(scenario.groundTruth);
  });

  it('fails loudly when the scenario has no recording (無音を 0 件成功にしない)', async () => {
    await expect(providerFor('p', 150).run({ ...scenario, id: 'missing' })).rejects.toThrow(/missing/);
  });
});

describe('runVoiceEvalSuite', () => {
  it('runs the same dataset across providers and returns a per-provider result', async () => {
    const report = await runVoiceEvalSuite({
      providers: [providerFor('transcribe', 150), providerFor('browser', 900)],
      scenarios: [scenario],
      profile,
    });

    expect(report.providers.map((p) => p.providerId)).toEqual(['transcribe', 'browser']);
    expect(report.providers[0]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(150);
    expect(report.providers[1]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(900);
  });

  it('applies the profile SLO per provider so a regression is attributable', async () => {
    const report = await runVoiceEvalSuite({
      providers: [providerFor('transcribe', 150), providerFor('browser', 900)],
      scenarios: [scenario],
      profile,
    });

    expect(report.providers[0]?.slo.violations.map((v) => v.metric)).not.toContain('stablePartialP50Ms');
    expect(report.providers[1]?.slo.violations.map((v) => v.metric)).toContain('stablePartialP50Ms');
    expect(report.providers[0]?.passed).toBe(true);
    expect(report.providers[1]?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('rejects a provider whose events violate the common schema (#369〜#372 の適合ゲート)', async () => {
    const broken: VoiceEvalProvider = {
      id: 'broken',
      run: async () =>
        ({
          schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
          sessionId: 'broken/sc-1',
          locale: 'ja-JP',
          providers: { stt: 'broken', tts: 'x', turn: 'x' },
          events: [
            { t: 100, turnIndex: 0, type: 'audio.onset' },
            { t: 10, turnIndex: 0, type: 'speech.end' },
          ],
          groundTruth: scenario.groundTruth,
        }) satisfies VoiceEvalSession,
    };

    const report = await runVoiceEvalSuite({ providers: [broken], scenarios: [scenario], profile });

    expect(report.providers[0]?.schemaErrors.length).toBeGreaterThan(0);
    expect(report.providers[0]?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('does not let a schema-invalid provider look green through an empty violation list', async () => {
    // 検証で落ちたセッションは計測されないので、SLO 違反は 0 件になりうる。
    // それを緑と読ませないために、総合判定はスキーマ違反も含める。
    const broken: VoiceEvalProvider = {
      id: 'broken',
      run: async () =>
        ({
          schemaVersion: 999,
          sessionId: 'broken/sc-1',
          locale: 'ja-JP',
          providers: { stt: 'broken', tts: 'x', turn: 'x' },
          events: [],
          groundTruth: scenario.groundTruth,
        }) as VoiceEvalSession,
    };

    const report = await runVoiceEvalSuite({ providers: [broken], scenarios: [scenario], profile });
    expect(report.providers[0]?.slo.violations).toEqual([]);
    expect(report.providers[0]?.passed).toBe(false);
  });

  it('surfaces a provider throwing as a failure instead of aborting the whole suite', async () => {
    const exploding: VoiceEvalProvider = {
      id: 'exploding',
      run: async () => {
        throw new Error('transport down');
      },
    };
    const report = await runVoiceEvalSuite({
      providers: [exploding, providerFor('ok', 150)],
      scenarios: [scenario],
      profile,
    });

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]?.errors.join()).toContain('transport down');
    expect(report.providers[0]?.passed).toBe(false);
    expect(report.providers[1]?.passed).toBe(true);
  });
});
