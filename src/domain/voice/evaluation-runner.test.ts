import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import { VOICE_EVAL_PROFILES } from './evaluation-thresholds';
import { createReplayProvider, runVoiceEvalSuite, type VoiceEvalProvider, type VoiceEvalScenario } from './evaluation-runner';

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
    nearEndOnsets: [],
  },
};

/** provider は時刻順にイベントを出す契約なので、fixture 側でも並べ替えてから返す。 */
function eventsFor(offsetMs: number): VoiceEvalEvent[] {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'audio.onset' },
    { t: 150 + offsetMs, turnIndex: 0, type: 'stt.partial', text: 'やまだ', stable: true },
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

function providerFor(id: string, offsetMs: number): VoiceEvalProvider {
  return createReplayProvider({
    id,
    providers: { stt: id, tts: 'mock-tts', turn: 'mock-turn' },
    sessionsByScenario: { 'sc-1': eventsFor(offsetMs) },
  });
}

describe('createReplayProvider', () => {
  it('replays a recorded stream as a schema-valid session', async () => {
    const session = await providerFor('p', 0).run(scenario);
    expect(session.schemaVersion).toBe(VOICE_EVAL_SCHEMA_VERSION);
    expect(session.sessionId).toBe('p/sc-1');
    expect(session.groundTruth).toEqual(scenario.groundTruth);
  });

  it('fails loudly when the scenario has no recording (無音を 0 件成功にしない)', async () => {
    await expect(providerFor('p', 0).run({ ...scenario, id: 'missing' })).rejects.toThrow(/missing/);
  });
});

describe('runVoiceEvalSuite', () => {
  it('runs the same dataset across providers and returns a per-provider result', async () => {
    const report = await runVoiceEvalSuite({
      providers: [providerFor('transcribe', 0), providerFor('browser', 400)],
      scenarios: [scenario],
      profile: VOICE_EVAL_PROFILES.uat,
    });

    expect(report.providers.map((p) => p.providerId)).toEqual(['transcribe', 'browser']);
    expect(report.providers[0]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(150);
    expect(report.providers[1]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(550);
  });

  it('applies the profile SLO per provider so a regression is attributable', async () => {
    const report = await runVoiceEvalSuite({
      providers: [providerFor('transcribe', 0), providerFor('browser', 400)],
      scenarios: [scenario],
      profile: VOICE_EVAL_PROFILES.uat,
    });

    expect(report.providers[0]?.slo.passed).toBe(true);
    expect(report.providers[1]?.slo.passed).toBe(false);
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

    const report = await runVoiceEvalSuite({
      providers: [broken],
      scenarios: [scenario],
      profile: VOICE_EVAL_PROFILES.uat,
    });

    expect(report.passed).toBe(false);
    expect(report.providers[0]?.schemaErrors.length).toBeGreaterThan(0);
  });

  it('surfaces a provider throwing as a failure instead of aborting the whole suite', async () => {
    const exploding: VoiceEvalProvider = {
      id: 'exploding',
      run: async () => {
        throw new Error('transport down');
      },
    };
    const report = await runVoiceEvalSuite({
      providers: [exploding, providerFor('ok', 0)],
      scenarios: [scenario],
      profile: VOICE_EVAL_PROFILES.uat,
    });

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]?.errors.join()).toContain('transport down');
    expect(report.providers[1]?.slo.passed).toBe(true);
  });
});
