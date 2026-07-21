import { describe, expect, it } from 'vitest';

import { VOICE_EVAL_SCHEMA_VERSION, type VoiceEvalEvent, type VoiceEvalSession } from './evaluation-events';
import { computeSessionMetrics, computeSuiteMetrics } from './evaluation-metrics';
import { toCsvReport, toJsonReport, toMarkdownReport } from './evaluation-report';
import { VOICE_EVAL_PROFILES, evaluateAgainstSlo } from './evaluation-thresholds';
import type { VoiceEvalProviderResult, VoiceEvalSuiteReport } from './evaluation-runner';

function session(id: string, partialAt: number): VoiceEvalSession {
  const events: VoiceEvalEvent[] = [
    { t: 0, turnIndex: 0, type: 'audio.onset' },
    { t: partialAt, turnIndex: 0, type: 'stt.partial', text: 'や', stable: true },
    { t: 1400, turnIndex: 0, type: 'speech.end' },
    { t: 1450, turnIndex: 0, type: 'stt.final', text: '山田' },
    { t: 1460, turnIndex: 0, type: 'turn.committed', text: '山田', trigger: 'silence' },
    { t: 1470, turnIndex: 0, type: 'tts.request', text: 'ok' },
    { t: 1540, turnIndex: 0, type: 'tts.first_byte' },
    { t: 1600, turnIndex: 0, type: 'tts.playback_start' },
    { t: 2400, turnIndex: 0, type: 'tts.playback_stopped', reason: 'completed' },
  ];
  return {
    schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
    sessionId: id,
    locale: 'ja-JP',
    providers: { stt: id, tts: 'polly', turn: 'rules' },
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
      nearEndStimuli: [],
    },
  };
}

function buildResult(id: string, partialAt: number): VoiceEvalProviderResult {
  const metrics = computeSuiteMetrics([computeSessionMetrics(session(id, partialAt))]);
  const slo = evaluateAgainstSlo(metrics, VOICE_EVAL_PROFILES.uat.thresholds, { strict: false });
  return { providerId: id, metrics, slo, schemaErrors: [], errors: [], passed: slo.passed };
}

function report(): VoiceEvalSuiteReport {
  const providers = [buildResult('transcribe', 200), buildResult('browser', 1200)];
  return {
    profile: VOICE_EVAL_PROFILES.uat.name,
    schemaVersion: VOICE_EVAL_SCHEMA_VERSION,
    scenarioCount: 1,
    providers,
    passed: providers.every((p) => p.passed),
  };
}

describe('toJsonReport', () => {
  it('round-trips through JSON.parse (機械可読なレポート出力)', () => {
    const parsed = JSON.parse(toJsonReport(report()));
    expect(parsed.profile).toBe('uat');
    expect(parsed.providers).toHaveLength(2);
    expect(parsed.providers[0].metrics.latency.audioOnsetToStablePartial.p50).toBe(200);
  });

  it('carries the schema version so old reports stay interpretable', () => {
    expect(JSON.parse(toJsonReport(report())).schemaVersion).toBe(VOICE_EVAL_SCHEMA_VERSION);
  });
});

describe('toCsvReport', () => {
  it('emits one row per provider with a stable header', () => {
    const lines = toCsvReport(report()).trim().split('\n');
    expect(lines[0]).toContain('provider');
    expect(lines[0]).toContain('stable_partial_p50_ms');
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('transcribe,')).toBe(true);
  });

  it('exposes schema and run error counts so a failed provider is visible in the table', () => {
    const header = toCsvReport(report()).trim().split('\n')[0] ?? '';
    expect(header).toContain('schema_errors');
    expect(header).toContain('run_errors');
    expect(header).toContain('passed');
  });

  it('writes an empty cell for an undecidable metric rather than 0', () => {
    const csv = toCsvReport(report());
    const header = csv.trim().split('\n')[0]?.split(',') ?? [];
    const row = csv.trim().split('\n')[1]?.split(',') ?? [];
    const idx = header.indexOf('barge_in_stop_p50_ms');
    expect(idx).toBeGreaterThan(-1);
    expect(row[idx]).toBe('');
  });

  it('quotes any provider id containing a comma', () => {
    const base = report();
    const withComma = { ...base, providers: [{ ...base.providers[0]!, providerId: 'a,b' }] };
    expect(toCsvReport(withComma)).toContain('"a,b"');
  });
});

describe('toMarkdownReport', () => {
  it('renders a P50/P95 comparison table across providers (遅延の可視化)', () => {
    const md = toMarkdownReport(report());
    expect(md).toContain('| transcribe |');
    expect(md).toContain('| browser |');
    expect(md).toContain('P95');
  });

  it('lists SLO violations with observed vs allowed so a regression is actionable', () => {
    const md = toMarkdownReport(report());
    expect(md).toContain('stablePartialP50Ms');
    expect(md).toContain('1200');
    expect(md).toContain('300');
  });

  it('marks the overall verdict', () => {
    expect(toMarkdownReport(report())).toContain('FAIL');
  });

  it('marks a provider FAIL when its sessions failed schema validation even with no SLO violation', () => {
    const base = report();
    const withSchemaError: VoiceEvalSuiteReport = {
      ...base,
      providers: [
        {
          ...base.providers[0]!,
          providerId: 'broken',
          slo: { passed: true, violations: [], skipped: [] },
          schemaErrors: ['sc-1: t が単調増加していない'],
          passed: false,
        },
      ],
    };
    const md = toMarkdownReport(withSchemaError);
    expect(md).toContain('### broken — FAIL');
    expect(md).toContain('スキーマ違反');
  });
});
