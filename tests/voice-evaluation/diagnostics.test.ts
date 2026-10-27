/**
 * 評価器の自己診断をハーネス全体で通す (#1200)。
 *
 * 純関数の単体テスト（`evaluation-diagnostics.test.ts`）は判定規則を縛る。ここでは
 * **合成 provider を実際に流して**、評価器が次を満たすことを不変条件として縛る:
 *
 * 1. **単調性** … どのノブを悪くしても「改善」と判定されず、狙った指標は劣化する
 *    （評価器が強い実装と弱い実装を見分けられること。見分けられない評価器では何も詰められない）
 * 2. **過学習の検知** … 調整に使ったシナリオでだけ速くなる provider は `overfit-suspect`
 * 3. **ノイズ** … ばらつきの内側の差は改善と読まない
 */
import { describe, expect, it } from 'vitest';

import type { VoiceEvalSession } from '@/domain/voice/evaluation-events';
import {
  METRIC_OPTIMUM,
  assessImprovement,
  compareSuiteMetrics,
  headroom,
  noiseFromRepeats,
  partitionScenarios,
  runRepeated,
} from '@/domain/voice/evaluation-diagnostics';
import type { VoiceEvalSuiteMetrics } from '@/domain/voice/evaluation-metrics';
import { runVoiceEvalSuite, type VoiceEvalProvider, type VoiceEvalScenario } from '@/domain/voice/evaluation-runner';
import { VOICE_EVAL_PROFILES } from '@/domain/voice/evaluation-thresholds';

import { VOICE_EVAL_DATASET, VOICE_EVAL_SCENARIOS } from './dataset';
import { BASELINE_SYNTHETIC_CONFIG, createSyntheticProvider, type SyntheticProviderConfig } from './synthetic-provider';

const profile = VOICE_EVAL_PROFILES.uat;
const thresholds = profile.thresholds;

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

async function suiteMetrics(p: VoiceEvalProvider, scenarios: readonly VoiceEvalScenario[] = VOICE_EVAL_SCENARIOS) {
  const report = await runVoiceEvalSuite({ providers: [p], scenarios, profile });
  const result = report.providers[0];
  if (!result) throw new Error('provider result missing');
  expect(result.schemaErrors).toEqual([]);
  expect(result.errors).toEqual([]);
  return result.metrics;
}

/**
 * 基準から 1 ノブずつ悪くした設定と、それで**必ず劣化するはずの指標**。
 * 合成 provider のノブを棚卸しして作った（`SyntheticProviderConfig` の全項目のうち、
 * 劣化の向きが定義できるもの）。
 */
const DEGRADATIONS: ReadonlyArray<[string, Partial<SyntheticProviderConfig>, string]> = [
  ['確定 partial を遅く', { stablePartialMs: 900 }, 'stablePartialP50Ms'],
  ['応答音声を遅く', { firstAudioMs: 900 }, 'shortAnswerFirstAudioP50Ms'],
  ['割り込み停止を遅く', { bargeInStopMs: 250 }, 'bargeInStopP50Ms'],
  ['viseme をずらす', { visemeSkewMs: 400 }, 'visemeSyncErrorP50Ms'],
  ['相づちでも止める', { bargeInPolicy: 'naive' }, 'maxFalseStopRate'],
  ['割り込みを止めない', { bargeInPolicy: 'deaf' }, 'minTrueInterruptionDetectionRate'],
  ['フィラーで確定', { turnPolicy: 'naive' }, 'maxFalseCommitRate'],
  ['ターンを取りこぼす', { turnPolicy: 'slow' }, 'maxMissedEndRate'],
  ['候補から漏らす', { entityRank: 'miss' }, 'minEntityTop3Rate'],
  ['途中で中断', { abortAtTurn: 0 }, 'maxAbortedSessionRate'],
  ['人名を取り違える', { misrecognitions: { 山田: '山打' } }, 'minPersonNameExactMatchRate'],
  // ↓ SLO に無い指標でしか見えない劣化（独立レビュー MAJOR 2 で棚卸しし直した）
  ['初回 partial を遅く', { firstPartialMs: 240 }, 'auxFirstPartialP50Ms'],
  ['ターン確定を遅く', { commitMs: 600 }, 'auxTurnCommitP50Ms'],
  ['TTS の first byte を遅く', { firstByteMs: 2000 }, 'auxTtsFirstByteP50Ms'],
  // TTS の各時刻は committed からの経過なので、要求を遅らせるなら後段も同じだけずらす
  // （要求だけを遅らせると request → first byte が縮み、「改善」に見える。合成モデルの誤りで
  // あって評価器の誤りではない。synthetic-provider.ts の注記）。
  [
    'TTS の要求から後を全部遅く',
    {
      synthesisRequestMs: BASELINE_SYNTHETIC_CONFIG.synthesisRequestMs + 300,
      firstByteMs: BASELINE_SYNTHETIC_CONFIG.firstByteMs + 300,
      firstAudioMs: BASELINE_SYNTHETIC_CONFIG.firstAudioMs + 300,
    },
    'auxCommitToFirstAudioP50Ms',
  ],
  ['正解を 2 位へ', { entityRank: 2 }, 'auxEntityTop1Rate'],
  ['正解を 3 位へ', { entityRank: 3 }, 'auxEntityTop1Rate'],
];

describe('単調性: 悪くした実装を「改善」と判定しない (#1200)', () => {
  it.each(DEGRADATIONS)('%s', async (_name, overrides, target) => {
    const base = await suiteMetrics(provider('base'));
    const worse = await suiteMetrics(provider('worse', overrides));
    const rows = compareSuiteMetrics(base, worse, thresholds);

    // 🔴 不変条件: どの指標も良くならない
    expect(rows.filter((r) => r.change === 'improved').map((r) => r.metric)).toEqual([]);
    // 🔴 下界: 狙った指標は実際に劣化する（全部 unchanged で空虚に満たさない）
    expect(rows.find((r) => r.metric === target)?.change).toBe('regressed');
  });

  it('検出遅れが許容予算の内側なら、どの指標も変化しない（予算は設計どおり）', async () => {
    const base = await suiteMetrics(provider('base'));
    const lagged = await suiteMetrics(provider('lagged', { onsetLagMs: 200 }));
    expect(compareSuiteMetrics(base, lagged, thresholds).filter((r) => r.change !== 'unchanged')).toEqual([]);
  });

  it('逆向き（悪い実装を基準に、基準の実装を候補にする）では「劣化」と判定しない', async () => {
    for (const [, overrides] of DEGRADATIONS) {
      const worse = await suiteMetrics(provider('worse', overrides));
      const base = await suiteMetrics(provider('base'));
      const rows = compareSuiteMetrics(worse, base, thresholds);
      expect(rows.filter((r) => r.change === 'regressed').map((r) => r.metric)).toEqual([]);
    }
  });
});

/**
 * train のシナリオでだけ別の（速い）provider に切り替える provider。
 * 「手元の失敗例に合わせてしきい値を詰めた」実装の形を再現する。
 */
function routing(id: string, onTrain: VoiceEvalProvider, otherwise: VoiceEvalProvider, trainIds: Set<string>): VoiceEvalProvider {
  return {
    id,
    run: (scenario) => (trainIds.has(scenario.id) ? onTrain : otherwise).run(scenario),
  };
}

describe('過学習の検知 (#1200)', () => {
  const { train, holdout } = partitionScenarios(VOICE_EVAL_SCENARIOS, { holdoutPercent: 40 });

  async function assess(candidate: VoiceEvalProvider) {
    const base = provider('base');
    return assessImprovement(
      {
        train: { baseline: await suiteMetrics(base, train), candidate: await suiteMetrics(candidate, train) },
        holdout: { baseline: await suiteMetrics(base, holdout), candidate: await suiteMetrics(candidate, holdout) },
      },
      thresholds,
    );
  }

  it('同梱データセットは両側とも空でない分割になる（前提）', () => {
    expect(train.length).toBeGreaterThan(0);
    expect(holdout.length).toBeGreaterThan(0);
  });

  it('🔴 train のシナリオでだけ速い provider は overfit-suspect', async () => {
    const tuned = routing(
      'tuned',
      provider('fast', { stablePartialMs: 150 }),
      provider('base'),
      new Set(train.map((s) => s.id)),
    );
    const a = await assess(tuned);
    expect(a.verdict).toBe('overfit-suspect');
  });

  it('どこでも速い provider は improved（負の対照）', async () => {
    const a = await assess(provider('fast', { stablePartialMs: 150 }));
    expect(a.verdict).toBe('improved');
  });

  it('holdout でだけ遅い provider は regressed', async () => {
    const leaky = routing(
      'leaky',
      provider('fast', { stablePartialMs: 150 }),
      provider('slow', { stablePartialMs: 400 }),
      new Set(train.map((s) => s.id)),
    );
    expect((await assess(leaky)).verdict).toBe('regressed');
  });
});

/**
 * 実行ごとに確定 partial の遅延が揺れる provider（実 STT の非決定性を模す）。
 * 揺れは決まった列から取り、テスト自体は決定論的に保つ。
 */
function jittery(id: string, stablePartialSeries: readonly number[]): VoiceEvalProvider {
  const byRun = stablePartialSeries.map((ms, i) => provider(`${id}-${i}`, { stablePartialMs: ms }));
  let calls = 0;
  const perRun = VOICE_EVAL_SCENARIOS.length;
  return {
    id,
    run: (scenario) => {
      const run = Math.floor(calls / perRun) % byRun.length;
      calls += 1;
      return byRun[run]!.run(scenario) as Promise<VoiceEvalSession>;
    },
  };
}

describe('ノイズ: ばらつきの内側の差を改善と読まない (#1200)', () => {
  it('反復の幅をノイズにすると、幅より小さい差は no-change・大きい差は improved', async () => {
    const runs = await runRepeated({
      provider: jittery('base', [250, 280, 240]),
      scenarios: VOICE_EVAL_SCENARIOS,
      profile,
      repeats: 3,
    });
    const noise = noiseFromRepeats(runs, thresholds);
    expect(noise.stablePartialP50Ms).toBe(40);

    const base = runs[0] as VoiceEvalSuiteMetrics; // 250ms の回
    const slight = await suiteMetrics(provider('slight', { stablePartialMs: 225 }));
    const clear = await suiteMetrics(provider('clear', { stablePartialMs: 150 }));
    const same = { baseline: base, candidate: slight };
    expect(assessImprovement({ train: same, holdout: same }, thresholds, noise).verdict).toBe('no-change');
    // 下界: ノイズを入れなければ同じ差は改善と読まれる（上の no-change が規則由来であること）
    expect(assessImprovement({ train: same, holdout: same }, thresholds).verdict).toBe('improved');
    const big = { baseline: base, candidate: clear };
    expect(assessImprovement({ train: big, holdout: big }, thresholds, noise).verdict).toBe('improved');
  });

  it.each([1, 0, 2.5])('repeats は 2 以上の整数（%s は拒む）', async (repeats) => {
    await expect(
      runRepeated({ provider: provider('base'), scenarios: VOICE_EVAL_SCENARIOS, profile, repeats }),
    ).rejects.toThrow(/repeats/);
  });

  it('🔴 壊れた回（実行エラー）を混ぜてばらつきを測らない', async () => {
    const base = provider('base');
    const flaky: VoiceEvalProvider = {
      id: 'broken',
      run: (scenario) =>
        scenario.id === VOICE_EVAL_SCENARIOS[0]!.id ? Promise.reject(new Error('transport down')) : base.run(scenario),
    };
    await expect(
      runRepeated({ provider: flaky, scenarios: VOICE_EVAL_SCENARIOS, profile, repeats: 2 }),
    ).rejects.toThrow(/壊れています.*transport down/);
  });

  it('🔴 スキーマ違反の回も混ぜない', async () => {
    const base = provider('base');
    const invalid: VoiceEvalProvider = {
      id: 'invalid',
      run: async (scenario) => ({ ...(await base.run(scenario)), schemaVersion: 999 }),
    };
    await expect(
      runRepeated({ provider: invalid, scenarios: VOICE_EVAL_SCENARIOS, profile, repeats: 2 }),
    ).rejects.toThrow(/壊れています/);
  });

  it('決定論的な provider は幅 0（同じ入力なら同じ指標）', async () => {
    const runs = await runRepeated({ provider: provider('base'), scenarios: VOICE_EVAL_SCENARIOS, profile, repeats: 2 });
    const noise = noiseFromRepeats(runs, thresholds);
    expect(Object.values(noise).every((v) => v === 0)).toBe(true);
  });
});

describe('伸びしろ (#1200)', () => {
  it('基準 provider で最良値に張り付いた指標を名指しする（これらは同梱データでは改善を示せない）', async () => {
    const h = headroom(await suiteMetrics(provider('base')), thresholds);
    // 合成データの基準 provider は、割合の指標を全部満点で通す ―― 劣化の検知には使えるが、
    // 候補の優劣を割合の指標で比べる根拠にはならない（docs/voice-evaluation-harness.md）。
    // 2026-09-28 実測: 割合の指標（SLO 11 個 + 補助 2 個）が**全部**張り付いている。データセットに実運用の失敗例を
    // 足してこの一覧が縮んだら、それは伸びしろが生まれたということなので、ここを更新する。
    const rateMetrics = Object.entries(METRIC_OPTIMUM)
      .filter(([, optimum]) => optimum !== null)
      .map(([metric]) => metric);
    expect([...h.saturated].sort()).toEqual(rateMetrics.sort());
  });

  it('劣化させた指標は張り付きから外れる（下界）', async () => {
    const h = headroom(await suiteMetrics(provider('naive', { bargeInPolicy: 'naive' })), thresholds);
    expect(h.saturated).not.toContain('maxFalseStopRate');
  });
});
