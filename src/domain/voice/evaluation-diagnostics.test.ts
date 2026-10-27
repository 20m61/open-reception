import { describe, expect, it } from 'vitest';

import {
  AUX_METRICS,
  METRIC_OPTIMUM,
  assessImprovement,
  compareSuiteMetrics,
  headroom,
  noiseFromRepeats,
  partitionScenarios,
} from './evaluation-diagnostics';
import type { VoiceEvalSuiteMetrics } from './evaluation-metrics';
import { VOICE_EVAL_PROFILES, listSloChecks, type VoiceEvalThresholds } from './evaluation-thresholds';

const thresholds = VOICE_EVAL_PROFILES.uat.thresholds;

/**
 * 指標の最小の組み立て。`listSloChecks` が読む箇所だけを埋め、残りは null（計測不能）にする。
 * 各テストは `patch` で読みたい箇所だけを差し替える。
 */
function metrics(patch: {
  stablePartialP50?: number | null;
  falseStopRate?: number | null;
  top3Rate?: number | null;
  corpusCer?: number | null;
}): VoiceEvalSuiteMetrics {
  const lat = (p50: number | null = null) => ({ count: p50 === null ? 0 : 1, p50, p95: p50, max: p50 });
  return {
    sessionCount: 1,
    latency: {
      audioOnsetToFirstPartial: lat(),
      audioOnsetToStablePartial: lat(patch.stablePartialP50 ?? null),
      speechEndToTurnCommitted: lat(),
      turnCommittedToFirstAudio: lat(),
      ttsRequestToFirstByte: lat(),
      speechEndToFirstAudio: lat(),
      speechEndToFirstAudioShortAnswer: lat(),
      speechEndToFirstAudioFreeForm: lat(),
      nearEndOnsetToPlaybackStopped: lat(),
      visemeSyncError: lat(),
    },
    stt: {
      corpusCer: patch.corpusCer ?? null,
      medianUtteranceCer: null,
      personNameExactMatchRate: null,
      departmentNameExactMatchRate: null,
    },
    turn: { falseCommitRate: null, missedEndRate: null, fillerFalseResponseRate: null },
    bargeIn: {
      falseStopRate: patch.falseStopRate ?? null,
      trueInterruptionDetectionRate: null,
      nearEndOnsetDetectionRate: null,
      unattributedStopRate: null,
    },
    entity: { top1Rate: null, top3Rate: patch.top3Rate ?? null, recall: null, precision: null },
    reliability: { abortedSessionRate: null },
  } as unknown as VoiceEvalSuiteMetrics;
}

function change(rows: ReturnType<typeof compareSuiteMetrics>, metric: keyof VoiceEvalThresholds) {
  return rows.find((r) => r.metric === metric)?.change;
}

describe('compareSuiteMetrics (#1200)', () => {
  it('SLO の向きで良し悪しを決める（上限は小さいほど、下限は大きいほど良い）', () => {
    const rows = compareSuiteMetrics(
      metrics({ stablePartialP50: 300, top3Rate: 0.8 }),
      metrics({ stablePartialP50: 200, top3Rate: 0.6 }),
      thresholds,
    );
    expect(change(rows, 'stablePartialP50Ms')).toBe('improved');
    expect(change(rows, 'minEntityTop3Rate')).toBe('regressed');
  });

  it('差がノイズ幅以下なら unchanged（幅ちょうども改善と読まない）', () => {
    const rows = compareSuiteMetrics(
      metrics({ stablePartialP50: 300 }),
      metrics({ stablePartialP50: 270 }),
      thresholds,
      { stablePartialP50Ms: 30 },
    );
    expect(change(rows, 'stablePartialP50Ms')).toBe('unchanged');
    const rows2 = compareSuiteMetrics(
      metrics({ stablePartialP50: 300 }),
      metrics({ stablePartialP50: 269 }),
      thresholds,
      { stablePartialP50Ms: 30 },
    );
    expect(change(rows2, 'stablePartialP50Ms')).toBe('improved');
  });

  it('悪化もノイズ幅以下なら unchanged（ばらつきを劣化と読まない）', () => {
    const rows = compareSuiteMetrics(
      metrics({ stablePartialP50: 300 }),
      metrics({ stablePartialP50: 330 }),
      thresholds,
      { stablePartialP50Ms: 30 },
    );
    expect(change(rows, 'stablePartialP50Ms')).toBe('unchanged');
    const rows2 = compareSuiteMetrics(
      metrics({ stablePartialP50: 300 }),
      metrics({ stablePartialP50: 331 }),
      thresholds,
      { stablePartialP50Ms: 30 },
    );
    expect(change(rows2, 'stablePartialP50Ms')).toBe('regressed');
  });

  it('🔴 計測できていたものが候補で計測不能になったら regressed（測れなくなったことを改善と読まない）', () => {
    const rows = compareSuiteMetrics(metrics({ falseStopRate: 0.1 }), metrics({}), thresholds);
    expect(change(rows, 'maxFalseStopRate')).toBe('regressed');
  });

  it('基準側が計測不能なら比べられない（unmeasured）', () => {
    const rows = compareSuiteMetrics(metrics({}), metrics({ falseStopRate: 0 }), thresholds);
    expect(change(rows, 'maxFalseStopRate')).toBe('unmeasured');
  });

  it('SLO の全項目と補助指標について 1 行ずつ返す（項目の取りこぼしで判定を甘くしない）', () => {
    const rows = compareSuiteMetrics(metrics({}), metrics({}), thresholds);
    expect(rows.map((r) => r.metric).sort()).toEqual(
      [...listSloChecks(metrics({}), thresholds).map((c) => c.metric), ...AUX_METRICS].sort(),
    );
  });

  it('基準の反復で幅が無限大の指標は、候補が測れなくても unchanged（変化を主張しない）', () => {
    const rows = compareSuiteMetrics(metrics({ falseStopRate: 0.1 }), metrics({}), thresholds, {
      maxFalseStopRate: Number.POSITIVE_INFINITY,
    });
    expect(change(rows, 'maxFalseStopRate')).toBe('unchanged');
  });
});

describe('noiseFromRepeats (#1200)', () => {
  it('指標ごとの幅（最大 − 最小）を返す', () => {
    const band = noiseFromRepeats(
      [metrics({ stablePartialP50: 240 }), metrics({ stablePartialP50: 270 }), metrics({ stablePartialP50: 250 })],
      thresholds,
    );
    expect(band.stablePartialP50Ms).toBe(30);
  });

  it('🔴 回によって計測できたりできなかったりする指標は幅を無限大にする（変化を主張させない）', () => {
    const band = noiseFromRepeats([metrics({ falseStopRate: 0 }), metrics({})], thresholds);
    expect(band.maxFalseStopRate).toBe(Number.POSITIVE_INFINITY);
  });

  it('1 回だけの実行ではばらつきを測れない（throw）', () => {
    expect(() => noiseFromRepeats([metrics({})], thresholds)).toThrow(/2 回以上/);
  });
});

describe('assessImprovement (#1200)', () => {
  const base = metrics({ stablePartialP50: 300, falseStopRate: 0.1 });

  it('holdout でも良くなれば improved', () => {
    const better = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement({ train: { baseline: base, candidate: better }, holdout: { baseline: base, candidate: better } }, thresholds);
    expect(a.verdict).toBe('improved');
  });

  it('🔴 train だけ良くなり holdout が横ばいなら overfit-suspect', () => {
    const better = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement({ train: { baseline: base, candidate: better }, holdout: { baseline: base, candidate: base } }, thresholds);
    expect(a.verdict).toBe('overfit-suspect');
    expect(a.reasons.join('\n')).toMatch(/holdout/);
  });

  it('どちらかで 1 つでも劣化すれば regressed（他が改善していても）', () => {
    const mixed = metrics({ stablePartialP50: 200, falseStopRate: 0.3 });
    const a = assessImprovement({ train: { baseline: base, candidate: mixed }, holdout: { baseline: base, candidate: mixed } }, thresholds);
    expect(a.verdict).toBe('regressed');
    expect(a.reasons.join('\n')).toMatch(/maxFalseStopRate/);
  });

  it('🔴 train 側だけの劣化も regressed（holdout が改善していても採らない）', () => {
    const trainWorse = metrics({ stablePartialP50: 300, falseStopRate: 0.3 });
    const holdoutBetter = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement(
      { train: { baseline: base, candidate: trainWorse }, holdout: { baseline: base, candidate: holdoutBetter } },
      thresholds,
    );
    expect(a.verdict).toBe('regressed');
    expect(a.reasons).toEqual(['train で劣化: maxFalseStopRate']);
  });

  it('holdout 側だけの劣化も regressed', () => {
    const worse = metrics({ stablePartialP50: 400, falseStopRate: 0.1 });
    const better = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement({ train: { baseline: base, candidate: better }, holdout: { baseline: base, candidate: worse } }, thresholds);
    expect(a.verdict).toBe('regressed');
    expect(a.reasons).toEqual(['holdout で劣化: stablePartialP50Ms']);
  });

  it('どこも変わらなければ no-change', () => {
    const a = assessImprovement({ train: { baseline: base, candidate: base }, holdout: { baseline: base, candidate: base } }, thresholds);
    expect(a.verdict).toBe('no-change');
  });

  it('🔴 holdout で 1 つも測れていなければ unmeasurable（train の改善を認めない）', () => {
    const better = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement(
      { train: { baseline: base, candidate: better }, holdout: { baseline: metrics({}), candidate: metrics({}) } },
      thresholds,
    );
    expect(a.verdict).toBe('unmeasurable');
  });

  it('train で 1 つも測れていなくても unmeasurable（比べる土台が無い）', () => {
    const better = metrics({ stablePartialP50: 200, falseStopRate: 0.1 });
    const a = assessImprovement(
      { train: { baseline: metrics({}), candidate: metrics({}) }, holdout: { baseline: base, candidate: better } },
      thresholds,
    );
    expect(a.verdict).toBe('unmeasurable');
  });

  it('ノイズ幅の内側の改善は改善と読まない', () => {
    const slight = metrics({ stablePartialP50: 290, falseStopRate: 0.1 });
    const a = assessImprovement(
      { train: { baseline: base, candidate: slight }, holdout: { baseline: base, candidate: slight } },
      thresholds,
      { stablePartialP50Ms: 20 },
    );
    expect(a.verdict).toBe('no-change');
  });
});

describe('partitionScenarios (#1200)', () => {
  const scenarios = Array.from({ length: 40 }, (_, i) => ({ id: `scenario-${i}` }));

  it('互いに素で、合わせると全部になる', () => {
    const { train, holdout } = partitionScenarios(scenarios, { holdoutPercent: 25 });
    expect(train.length + holdout.length).toBe(scenarios.length);
    const ids = new Set([...train, ...holdout].map((s) => s.id));
    expect(ids.size).toBe(scenarios.length);
  });

  it('🔴 並び順に依存しない（ID だけで決まる = 都合のよい分割を後から選べない）', () => {
    const a = partitionScenarios(scenarios, { holdoutPercent: 25 });
    const b = partitionScenarios([...scenarios].reverse(), { holdoutPercent: 25 });
    expect(a.holdout.map((s) => s.id).sort()).toEqual(b.holdout.map((s) => s.id).sort());
  });

  it('割合がおおむね守られ、両側とも空にならない', () => {
    const { train, holdout } = partitionScenarios(scenarios, { holdoutPercent: 25 });
    expect(holdout.length).toBeGreaterThan(4);
    expect(holdout.length).toBeLessThan(16);
    expect(train.length).toBeGreaterThan(0);
  });

  it('どちらかが空になる分割は throw（測れない分割を黙って返さない）', () => {
    expect(() => partitionScenarios([{ id: 'only' }], { holdoutPercent: 25 })).toThrow(/空/);
  });

  it.each([0, 100, -1, 50.5])('holdoutPercent は 1〜99 の整数（%s は throw）', (p) => {
    expect(() => partitionScenarios(scenarios, { holdoutPercent: p })).toThrow(/holdoutPercent/);
  });

  it('salt を変えると別の分割になり、同じ salt なら同じ分割になる', () => {
    const ids = (salt: string) =>
      partitionScenarios(scenarios, { holdoutPercent: 25, salt })
        .holdout.map((s) => s.id)
        .sort();
    expect(ids('a')).toEqual(ids('a'));
    expect(ids('a')).not.toEqual(ids('b'));
  });
});

describe('headroom (#1200)', () => {
  it('最良値に張り付いた割合指標を名指しし、遅延は名指ししない（遅延に最良値は無い）', () => {
    const h = headroom(metrics({ falseStopRate: 0, top3Rate: 1, stablePartialP50: 1, corpusCer: 0.01 }), thresholds);
    expect(h.saturated.sort()).toEqual(['maxFalseStopRate', 'minEntityTop3Rate']);
  });

  it('計測不能の指標は張り付きとも余地ありとも言わない', () => {
    expect(headroom(metrics({}), thresholds).saturated).toEqual([]);
  });

  it('最良値の表は SLO の全項目と補助指標を持つ（項目を足したら最良値も決める）', () => {
    expect(Object.keys(METRIC_OPTIMUM).sort()).toEqual([...Object.keys(thresholds), ...AUX_METRICS].sort());
  });

  it('最良値は向きと単位から決まる（誤り率 0・一致率 1・遅延は無し）', () => {
    for (const [metric, optimum] of Object.entries(METRIC_OPTIMUM)) {
      if (metric.endsWith('Ms')) expect(optimum, metric).toBeNull();
      else if (/^(max|auxFiller)/.test(metric)) expect(optimum, metric).toBe(0);
      else expect(optimum, metric).toBe(1);
    }
  });
});
