/**
 * 評価器の自己診断 (issue #1200)。
 *
 * ## なぜ要るか
 *
 * 評価ハーネス（#365）は「1 ノブ崩すと該当指標だけ赤」を固定している。これは **SLO を割ったか**の
 * 検知であって、**2 つの実装のどちらが良いか**の判定ではない。実 provider（#370 の Transcribe、
 * VAD のしきい値調整など）を詰めていく段になると、後者が要る。そこで間違えやすいのが次の 3 つで、
 * いずれも eval 設計の定石（claude.dev「Automating eval design and hillclimbing」）が名指ししている:
 *
 * 1. **ばらつきの内側の差を改善と読む** … 実 provider は非決定的。1 回ずつ比べて「P50 が 5ms 速い」は
 *    何も言っていない。反復実行の幅（`noiseFromRepeats`）をノイズ幅にして、それを超えた差だけを数える
 * 2. **調整に使ったケースでだけ良くなる（過学習）** … しきい値を手元の失敗例に合わせて詰めると、
 *    そのケースでは緑になるが一般化しない。シナリオを train / holdout に分け、train だけが良くなり
 *    holdout が横ばいなら `overfit-suspect` とする（`assessImprovement`）
 * 3. **伸びしろの無い指標で改善を測ろうとする** … 基準 provider で最良値（誤停止率 0・一致率 1）に
 *    張り付いた指標は、そのデータセットでは改善を示せない（`headroom`）
 *
 * ## 判定の向き
 *
 * 「何が良い向きか」は SLO の向き（`listSloChecks` の `direction`）から取る。ここで別に書くと、
 * 片方だけ直ったときに比較と SLO 判定が食い違う。
 *
 * ## fail-closed
 *
 * - 基準で測れていたものが候補で測れなくなったら **劣化**（測れなくなったことを改善と読まない）
 * - 回によって測れたり測れなかったりする指標のノイズ幅は **無限大**（変化を主張させない）
 * - holdout か train のどちらかで 1 つも測れていなければ `unmeasurable`
 * - 基準の反復で測れたり測れなかったりした指標（幅 = 無限大）は、候補がどうであれ `unchanged`
 */
import type { VoiceEvalSuiteMetrics } from './evaluation-metrics';
import { runVoiceEvalSuite, type VoiceEvalProvider, type VoiceEvalScenario } from './evaluation-runner';
import { listSloChecks, type VoiceEvalProfile, type VoiceEvalThresholds } from './evaluation-thresholds';

/**
 * SLO には無いが、**実装の優劣には効く**指標（独立レビュー MAJOR 2）。
 *
 * 比較を SLO の項目だけで行うと、初回 partial・ターン確定・TTS の first byte の遅延、Top1 率、
 * フィラー起因の誤応答が見えない —— 実測で、`entityRank: 3`（正解を 1 位から 3 位へ落とす）の
 * 候補が `no-change` になった。優劣の比較では SLO の門より広く見る。
 */
export const AUX_METRICS = [
  'auxFirstPartialP50Ms',
  'auxTurnCommitP50Ms',
  'auxTtsFirstByteP50Ms',
  'auxCommitToFirstAudioP50Ms',
  'auxEntityTop1Rate',
  'auxFillerFalseResponseRate',
] as const;
export type AuxMetric = (typeof AUX_METRICS)[number];

/** 比較する指標: SLO の全項目と、上の補助指標。 */
export type MetricKey = keyof VoiceEvalThresholds | AuxMetric;

type ComparedCheck = { metric: MetricKey; label: string; direction: 'max' | 'min'; observed: number | null };

function auxChecks(m: VoiceEvalSuiteMetrics): Record<AuxMetric, ComparedCheck> {
  return {
    auxFirstPartialP50Ms: {
      metric: 'auxFirstPartialP50Ms',
      label: '初回 partial 遅延 P50',
      direction: 'max',
      observed: m.latency.audioOnsetToFirstPartial.p50,
    },
    auxTurnCommitP50Ms: {
      metric: 'auxTurnCommitP50Ms',
      label: 'speech end → ターン確定 P50',
      direction: 'max',
      observed: m.latency.speechEndToTurnCommitted.p50,
    },
    auxTtsFirstByteP50Ms: {
      metric: 'auxTtsFirstByteP50Ms',
      label: 'TTS request → first byte P50',
      direction: 'max',
      observed: m.latency.ttsRequestToFirstByte.p50,
    },
    auxCommitToFirstAudioP50Ms: {
      metric: 'auxCommitToFirstAudioP50Ms',
      label: 'ターン確定 → first audio P50',
      direction: 'max',
      observed: m.latency.turnCommittedToFirstAudio.p50,
    },
    auxEntityTop1Rate: {
      metric: 'auxEntityTop1Rate',
      label: '担当者候補 Top1 率',
      direction: 'min',
      observed: m.entity.top1Rate,
    },
    auxFillerFalseResponseRate: {
      metric: 'auxFillerFalseResponseRate',
      label: 'フィラー起因の誤応答率',
      direction: 'max',
      observed: m.turn.fillerFalseResponseRate,
    },
  };
}

/** 比較に使う全項目（SLO + 補助）。「何が良い向きか」は SLO 側の定義をそのまま使う。 */
function comparedChecks(m: VoiceEvalSuiteMetrics, thresholds: VoiceEvalThresholds): ComparedCheck[] {
  return [...listSloChecks(m, thresholds), ...Object.values(auxChecks(m))];
}

/** 指標ごとのノイズ幅（この幅以下の差は変化と読まない）。書かない指標は 0。 */
export type NoiseBand = Partial<Record<MetricKey, number>>;

export type MetricChange = 'improved' | 'regressed' | 'unchanged' | 'unmeasured';

export type MetricComparison = {
  metric: MetricKey;
  label: string;
  direction: 'max' | 'min';
  baseline: number | null;
  candidate: number | null;
  noise: number;
  change: MetricChange;
};

/**
 * 基準と候補を、SLO の全項目と補助指標（`AUX_METRICS`）について比べる。
 *
 * 良さの差 = 上限（max）なら `baseline - candidate`、下限（min）なら `candidate - baseline`。
 * 差が**ノイズ幅を超えたとき**だけ improved / regressed とする（幅ちょうどは unchanged）。
 */
export function compareSuiteMetrics(
  baseline: VoiceEvalSuiteMetrics,
  candidate: VoiceEvalSuiteMetrics,
  thresholds: VoiceEvalThresholds,
  noise: NoiseBand = {},
): MetricComparison[] {
  const candidateChecks = new Map(comparedChecks(candidate, thresholds).map((c) => [c.metric, c]));
  return comparedChecks(baseline, thresholds).map((b) => {
    const c = candidateChecks.get(b.metric);
    const band = noise[b.metric] ?? 0;
    const row = {
      metric: b.metric,
      label: b.label,
      direction: b.direction,
      baseline: b.observed,
      candidate: c?.observed ?? null,
      noise: band,
    };
    if (b.observed === null) return { ...row, change: 'unmeasured' as const };
    // 基準自身が反復で測れたり測れなかったりする指標（幅 = 無限大）は、変化を主張しない ——
    // 候補が測れなかった回でも劣化とは言えない（独立レビュー MINOR）。
    if (band === Number.POSITIVE_INFINITY) return { ...row, change: 'unchanged' as const };
    if (row.candidate === null) return { ...row, change: 'regressed' as const };
    const gain = b.direction === 'max' ? b.observed - row.candidate : row.candidate - b.observed;
    const change: MetricChange = gain > band ? 'improved' : gain < -band ? 'regressed' : 'unchanged';
    return { ...row, change };
  });
}

/**
 * 同じ provider を反復実行した指標から、指標ごとのばらつき幅（最大 − 最小）を出す。
 *
 * 回によって null（計測不能）が混じる指標は幅を無限大にする —— 「測れた回の値だけで幅を取る」と、
 * 測れなかった回を黙って捨てることになり、不安定な指標に変化を主張させてしまう。
 */
export function noiseFromRepeats(
  runs: readonly VoiceEvalSuiteMetrics[],
  thresholds: VoiceEvalThresholds,
): NoiseBand {
  if (runs.length < 2) throw new Error('ばらつきを測るには 2 回以上の実行が要ります');
  const values = new Map<MetricKey, (number | null)[]>();
  for (const run of runs) {
    for (const check of comparedChecks(run, thresholds)) {
      const list = values.get(check.metric) ?? [];
      list.push(check.observed);
      values.set(check.metric, list);
    }
  }
  const band: NoiseBand = {};
  for (const [metric, list] of values) {
    const measured = list.filter((v): v is number => v !== null);
    if (measured.length === 0) continue; // 一度も測れていない指標は比較対象にならない（unmeasured）
    band[metric] =
      measured.length < list.length ? Number.POSITIVE_INFINITY : Math.max(...measured) - Math.min(...measured);
  }
  return band;
}

export type ImprovementVerdict = 'improved' | 'overfit-suspect' | 'regressed' | 'no-change' | 'unmeasurable';

export type SplitMetrics = { baseline: VoiceEvalSuiteMetrics; candidate: VoiceEvalSuiteMetrics };

export type ImprovementAssessment = {
  verdict: ImprovementVerdict;
  train: MetricComparison[];
  holdout: MetricComparison[];
  reasons: string[];
};

function names(rows: readonly MetricComparison[], change: MetricChange): string[] {
  return rows.filter((r) => r.change === change).map((r) => r.metric);
}

/**
 * train / holdout の比較から、候補を採るべきかを判定する。
 *
 * 優先順（上ほど強い）:
 * 1. どちらかの側で 1 つでも劣化 → `regressed`（他が改善していても採らない）
 * 2. holdout か train で 1 つも測れていない → `unmeasurable`
 * 3. holdout で 1 つ以上改善 → `improved`
 * 4. train でだけ改善 → `overfit-suspect`
 * 5. それ以外 → `no-change`
 */
export function assessImprovement(
  splits: { train: SplitMetrics; holdout: SplitMetrics },
  thresholds: VoiceEvalThresholds,
  noise: NoiseBand = {},
): ImprovementAssessment {
  const train = compareSuiteMetrics(splits.train.baseline, splits.train.candidate, thresholds, noise);
  const holdout = compareSuiteMetrics(splits.holdout.baseline, splits.holdout.candidate, thresholds, noise);
  const reasons: string[] = [];

  const regressedTrain = names(train, 'regressed');
  const regressedHoldout = names(holdout, 'regressed');
  if (regressedTrain.length > 0 || regressedHoldout.length > 0) {
    if (regressedTrain.length > 0) reasons.push(`train で劣化: ${regressedTrain.join(', ')}`);
    if (regressedHoldout.length > 0) reasons.push(`holdout で劣化: ${regressedHoldout.join(', ')}`);
    return { verdict: 'regressed', train, holdout, reasons };
  }
  const unmeasured = (rows: readonly MetricComparison[]) => rows.every((r) => r.change === 'unmeasured');
  if (unmeasured(holdout) || unmeasured(train)) {
    if (unmeasured(holdout)) reasons.push('holdout で測れた指標が 1 つも無い —— 改善が一般化するか確かめられない');
    if (unmeasured(train)) reasons.push('train で測れた指標が 1 つも無い —— 比べる土台が無い');
    return { verdict: 'unmeasurable', train, holdout, reasons };
  }
  const improvedHoldout = names(holdout, 'improved');
  if (improvedHoldout.length > 0) {
    reasons.push(`holdout で改善: ${improvedHoldout.join(', ')}`);
    return { verdict: 'improved', train, holdout, reasons };
  }
  const improvedTrain = names(train, 'improved');
  if (improvedTrain.length > 0) {
    reasons.push(
      `train でだけ改善（${improvedTrain.join(', ')}）し、holdout は横ばい —— 調整に使ったケースへの過学習を疑う`,
    );
    return { verdict: 'overfit-suspect', train, holdout, reasons };
  }
  return { verdict: 'no-change', train, holdout, reasons };
}

/** FNV-1a（32bit）。依存を足さずに ID から安定した値を得るためだけに使う。 */
function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * シナリオを train / holdout に分ける。**ID のハッシュだけで決まる**（並び順・実行結果に依らない）。
 *
 * 分割を人が選べると、候補に都合のよい分割を後から選べてしまう（それ自体が過学習）。
 * `salt` を変えると別の分割になるが、使うなら事前に決めて記録しておくこと。
 */
export function partitionScenarios<T extends { id: string }>(
  scenarios: readonly T[],
  options: { holdoutPercent: number; salt?: string },
): { train: T[]; holdout: T[] } {
  const p = options.holdoutPercent;
  if (!Number.isInteger(p) || p < 1 || p > 99) {
    throw new Error(`holdoutPercent は 1〜99 の整数です: ${p}`);
  }
  const train: T[] = [];
  const holdout: T[] = [];
  for (const s of scenarios) {
    (stableHash(JSON.stringify([options.salt ?? '', s.id])) % 100 < p ? holdout : train).push(s);
  }
  if (train.length === 0 || holdout.length === 0) {
    throw new Error(
      `分割の片側が空です（train ${train.length} / holdout ${holdout.length}）。シナリオを増やすか割合を変えてください`,
    );
  }
  return { train, holdout };
}

/**
 * 指標の最良値。**割合の指標だけが持つ**（誤り率は 0、一致率・検出率は 1）。補助指標も含む。
 * 遅延には最良値が無い（0ms は達成目標ではない）ので null。
 *
 * `Record<MetricKey, …>` にしてあるので、SLO の項目を足すとここを埋めるまで型検査が落ちる。
 */
export const METRIC_OPTIMUM: Readonly<Record<MetricKey, number | null>> = {
  stablePartialP50Ms: null,
  bargeInStopP50Ms: null,
  bargeInStopP95Ms: null,
  shortAnswerFirstAudioP50Ms: null,
  freeFormFirstAudioP50Ms: null,
  visemeSyncErrorP50Ms: null,
  maxFalseStopRate: 0,
  minTrueInterruptionDetectionRate: 1,
  minNearEndOnsetDetectionRate: 1,
  maxUnattributedBargeInStopRate: 0,
  maxFalseCommitRate: 0,
  maxMissedEndRate: 0,
  maxCorpusCer: 0,
  minPersonNameExactMatchRate: 1,
  minDepartmentNameExactMatchRate: 1,
  minEntityTop3Rate: 1,
  maxAbortedSessionRate: 0,
  auxFirstPartialP50Ms: null,
  auxTurnCommitP50Ms: null,
  auxTtsFirstByteP50Ms: null,
  auxCommitToFirstAudioP50Ms: null,
  auxEntityTop1Rate: 1,
  auxFillerFalseResponseRate: 0,
};

/**
 * 伸びしろ診断: 最良値に張り付いている指標を名指しする。
 *
 * 張り付いた指標は、そのデータセットでは**これ以上の改善を示せない**。劣化の検知には使えるが、
 * 「候補のほうが良い」の根拠にはならない。改善を測りたいなら、その指標で基準 provider が
 * 落とすケースをデータセットへ足す（ただし「今の実装が落ちるケースだけを集める」と
 * その実装の癖に合わせたデータセットになるので、実運用の失敗例から採る）。
 */
export function headroom(
  metrics: VoiceEvalSuiteMetrics,
  thresholds: VoiceEvalThresholds,
): { saturated: MetricKey[] } {
  const saturated = comparedChecks(metrics, thresholds)
    .filter((c) => {
      const optimum = METRIC_OPTIMUM[c.metric];
      return optimum !== null && c.observed !== null && c.observed === optimum;
    })
    .map((c) => c.metric);
  return { saturated };
}

/**
 * 同じ provider を `repeats` 回流し、各回のスイート指標を返す（`noiseFromRepeats` の入力）。
 * 実行エラーやスキーマ違反があれば throw する —— 壊れた回を混ぜてばらつきを測らない。
 */
export async function runRepeated(config: {
  provider: VoiceEvalProvider;
  scenarios: readonly VoiceEvalScenario[];
  profile: VoiceEvalProfile;
  repeats: number;
}): Promise<VoiceEvalSuiteMetrics[]> {
  if (!Number.isInteger(config.repeats) || config.repeats < 2) {
    throw new Error(`repeats は 2 以上の整数です: ${config.repeats}`);
  }
  const runs: VoiceEvalSuiteMetrics[] = [];
  for (let i = 0; i < config.repeats; i++) {
    const report = await runVoiceEvalSuite({
      providers: [config.provider],
      scenarios: config.scenarios,
      profile: config.profile,
    });
    const result = report.providers[0];
    if (!result) throw new Error('provider の結果がありません');
    if (result.errors.length > 0 || result.schemaErrors.length > 0) {
      throw new Error(
        `反復 ${i + 1} 回目が壊れています: ${[...result.errors, ...result.schemaErrors].slice(0, 3).join(' / ')}`,
      );
    }
    runs.push(result.metrics);
  }
  return runs;
}
