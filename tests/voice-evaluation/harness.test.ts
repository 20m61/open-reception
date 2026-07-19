/**
 * 評価ハーネスのオフライン実行 (issue #365)。
 *
 * 合成データセットを複数 provider に流し、指標算出 → SLO 判定 → レポート出力までを
 * ネットワーク・実音声なしで再現する。「基準 provider は緑」「1 ノブ崩すと該当指標だけ赤」
 * を確認することで、SLO 低下がレポートで検知できることを担保する（#365 AC）。
 */
import { describe, expect, it } from 'vitest';

import { validateVoiceEvalSession } from '@/domain/voice/evaluation-events';
import { toCsvReport, toJsonReport, toMarkdownReport } from '@/domain/voice/evaluation-report';
import { runVoiceEvalSuite, type VoiceEvalProvider } from '@/domain/voice/evaluation-runner';
import { VOICE_EVAL_PROFILES } from '@/domain/voice/evaluation-thresholds';

import { VOICE_EVAL_DATASET, VOICE_EVAL_SCENARIOS } from './dataset';
import { BASELINE_SYNTHETIC_CONFIG, createSyntheticProvider, type SyntheticProviderConfig } from './synthetic-provider';

function provider(id: string, overrides: Partial<SyntheticProviderConfig> = {}): VoiceEvalProvider {
  return createSyntheticProvider(
    {
      ...BASELINE_SYNTHETIC_CONFIG,
      id,
      providers: { stt: `${id}-stt`, tts: `${id}-tts`, turn: `${id}-turn` },
      ...overrides,
    },
    VOICE_EVAL_DATASET,
  );
}

const profile = VOICE_EVAL_PROFILES.uat;

async function runWith(p: VoiceEvalProvider) {
  const report = await runVoiceEvalSuite({ providers: [p], scenarios: VOICE_EVAL_SCENARIOS, profile });
  const result = report.providers[0];
  if (!result) throw new Error('provider result missing');
  return { report, result };
}

describe('データセット', () => {
  it('#365 が挙げる切り口を網羅している', () => {
    const tags = new Set(VOICE_EVAL_SCENARIOS.flatMap((s) => s.tags));
    for (const required of ['person-name', 'homophone', 'department', 'filler', 'barge-in', 'backchannel', 'echo']) {
      expect(tags.has(required)).toBe(true);
    }
  });

  it('実音声への参照を一切持たない（合成発話のみ）', () => {
    for (const scenario of VOICE_EVAL_SCENARIOS) {
      expect(scenario.input.kind).toBe('synthetic');
    }
  });

  it('近端発話の注釈数が仕様の発生数と一致する', () => {
    for (const entry of VOICE_EVAL_DATASET) {
      expect(entry.scenario.groundTruth.nearEndOnsets).toHaveLength(entry.nearEnd.length);
    }
  });
});

describe('合成 provider の適合', () => {
  it('生成したセッションが共通スキーマを満たす（#369〜#372 の適合ゲートと同じ検証）', async () => {
    const p = provider('baseline');
    for (const scenario of VOICE_EVAL_SCENARIOS) {
      const session = await p.run(scenario);
      expect(validateVoiceEvalSession(session).errors).toEqual([]);
    }
  });

  it('決定論的である（同じ入力なら同じイベント列）', async () => {
    const first = await provider('baseline').run(VOICE_EVAL_SCENARIOS[0]!);
    const second = await provider('baseline').run(VOICE_EVAL_SCENARIOS[0]!);
    expect(first.events).toEqual(second.events);
  });
});

describe('SLO 判定', () => {
  it('基準 provider は実機 SLO を満たす', async () => {
    const { result } = await runWith(provider('baseline'));
    expect(result.slo.violations).toEqual([]);
    expect(result.schemaErrors).toEqual([]);
  });

  it('確定 partial を遅くすると該当指標だけが違反になる', async () => {
    const { result } = await runWith(provider('slow-stt', { stablePartialMs: 900 }));
    expect(result.slo.violations.map((v) => v.metric)).toEqual(['stablePartialP50Ms']);
    expect(result.slo.violations[0]?.observed).toBe(900);
  });

  it('応答音声を遅くすると短答の first audio SLO が違反になる', async () => {
    const { result } = await runWith(provider('slow-tts', { firstAudioMs: 900, firstByteMs: 800 }));
    expect(result.slo.violations.map((v) => v.metric)).toContain('shortAnswerFirstAudioP50Ms');
  });

  it('相づちで止まる provider は誤割り込み率で落ちる', async () => {
    const { result } = await runWith(provider('naive-barge-in', { bargeInPolicy: 'naive' }));
    expect(result.slo.violations.map((v) => v.metric)).toContain('maxFalseStopRate');
    expect(result.metrics.bargeIn.backchannelFalseStopRate).toBe(1);
    expect(result.metrics.bargeIn.echoFalseStopRate).toBe(1);
  });

  it('割り込みを取りこぼす provider は誤停止こそ 0 だが検出率が 0 になる', async () => {
    const { result } = await runWith(provider('deaf', { bargeInPolicy: 'deaf' }));
    expect(result.metrics.bargeIn.falseStopRate).toBe(0);
    expect(result.metrics.bargeIn.trueInterruptionDetectionRate).toBe(0);
  });

  it('フィラーで切る provider は誤ターン終了率で落ちる', async () => {
    const { result } = await runWith(provider('naive-turn', { turnPolicy: 'naive' }));
    expect(result.slo.violations.map((v) => v.metric)).toContain('maxFalseCommitRate');
    expect(result.metrics.turn.fillerFalseResponseRate).toBe(1);
  });

  it('ターンを取りこぼす provider は誤終了 0 のまま終了見逃しに出る', async () => {
    const { result } = await runWith(provider('slow-turn', { turnPolicy: 'slow' }));
    expect(result.metrics.turn.falseCommitRate).toBe(0);
    expect(result.metrics.turn.missedEndRate).toBeGreaterThan(0);
  });

  it('担当者候補の順位が落ちると Top3 は保たれても Top1 が下がる', async () => {
    const { result } = await runWith(provider('rank3', { entityRank: 3 }));
    expect(result.metrics.entity.top3Rate).toBe(1);
    expect(result.metrics.entity.top1Rate).toBe(0);
  });

  it('候補から漏れると Top3 SLO で落ちる', async () => {
    const { result } = await runWith(provider('entity-miss', { entityRank: 'miss' }));
    expect(result.slo.violations.map((v) => v.metric)).toContain('minEntityTop3Rate');
  });
});

describe('固有名詞の精度は CER と別に見える', () => {
  it('同音異字の取り違えは CER が小さくても人名一致率で落ちる', async () => {
    const { result } = await runWith(provider('homophone', { misrecognitions: { 斎藤: '佐藤', 山田: '山下' } }));
    expect(result.metrics.stt.cer.p50).toBeLessThan(0.3);
    expect(result.metrics.stt.personNameExactMatchRate).toBeLessThan(1);
  });

  it('誤りを注入しない provider は人名も部門名も完全一致する', async () => {
    const { result } = await runWith(provider('clean'));
    expect(result.metrics.stt.cer.max).toBe(0);
    expect(result.metrics.stt.personNameExactMatchRate).toBe(1);
    expect(result.metrics.stt.departmentNameExactMatchRate).toBe(1);
  });
});

describe('provider 比較とレポート', () => {
  it('同一データセットで複数 provider を比較できる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('transcribe'), provider('browser', { stablePartialMs: 700, entityRank: 2 })],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile,
    });

    expect(report.providers).toHaveLength(2);
    expect(report.providers[0]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(250);
    expect(report.providers[1]?.metrics.latency.audioOnsetToStablePartial.p50).toBe(700);
    expect(report.passed).toBe(false); // browser 側が SLO を割る
  });

  it('JSON / CSV / Markdown を出力できる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('transcribe'), provider('browser', { stablePartialMs: 700 })],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile,
    });

    expect(JSON.parse(toJsonReport(report)).providers).toHaveLength(2);
    expect(toCsvReport(report).trim().split('\n')).toHaveLength(3);

    const markdown = toMarkdownReport(report);
    expect(markdown).toContain('| transcribe |');
    expect(markdown).toContain('stablePartialP50Ms');
  });

  it('レポートに生の書き起こしを載せない（共有されうるため PII を持ち出さない）', async () => {
    const { report } = await runWith(provider('baseline'));
    const json = toJsonReport(report);
    expect(json).not.toContain('山田');
    expect(json).not.toContain('アクメコーポレーション');
  });
});

describe('プロファイル', () => {
  it('軽量な ci プロファイルは合成データの基準 provider で緑になる', async () => {
    const report = await runVoiceEvalSuite({
      providers: [provider('baseline')],
      scenarios: VOICE_EVAL_SCENARIOS,
      profile: VOICE_EVAL_PROFILES.ci,
    });
    expect(report.passed).toBe(true);
  });
});
