/**
 * 受付体験 KPI の集計 (issue #319)。
 *
 * ReceptionLog（+ optional な experience メトリクス）から、受付体験の KPI を導く純関数群。
 * KPI 定義（分子/分母）は docs/reception-experience-kpi.md に明記する。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。期間フィルタは呼び出し側が行い、本モジュールは
 * 渡された（＝期間で絞り込み済みの）ログ集合に対して集計する（期間非依存）。「本日」集計は
 * dashboard-summary が JST 境界で絞ってから本関数へ渡す（#254 の JST ヘルパと境界を揃える）。
 *
 * PII 最小化: 集計対象・結果ともに所要 ms・件数・列挙のみ。来訪者 PII は一切扱わない。
 */
import type {
  ExperienceInputMethod,
  ExperienceStep,
  ReceptionExperience,
  ReceptionLog,
} from './log';

// ExperienceInputMethod は inputMethods 集計の型に使う（下の Record で参照）。

/** ファネルのステップ順（受付開始 → 呼び出し確定 → 接続）。 */
export const EXPERIENCE_STEP_ORDER: readonly ExperienceStep[] = [
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
  'calling',
  'connected',
];

/** 「30 秒以内」判定のしきい値 (ms)。KPI 定義（docs/reception-experience-kpi.md）と一致させる。 */
export const CALL_START_TARGET_MS = 30_000;

/** ステップ別の到達・離脱件数。 */
export type ExperienceFunnelStep = {
  step: ExperienceStep;
  /** そのステップに到達した受付数（単調非増加）。 */
  reached: number;
  /** そのステップで離脱した受付数（abandonedAtStep 一致）。 */
  abandoned: number;
};

/** 受付体験 KPI の集計結果。 */
export type ExperienceKpi = {
  /** 集計対象の受付総数（全ログ）。 */
  total: number;
  /** 体験メトリクスが記録された受付数（体験 KPI の主分母）。 */
  measured: number;
  /** 30 秒以内に呼び出しを開始できた率（0..1）。呼び出し到達がゼロなら null。 */
  callStartWithin30sRate: number | null;
  /** 30 秒 KPI の生値（分子 within / 分母 reached=呼び出し到達）。 */
  callStartWithin30s: { within: number; reached: number };
  /** 完遂率（connected / 全ログ, 0..1）。対象ゼロなら null。 */
  completionRate: number | null;
  /** 完遂率の生値。 */
  completion: { connected: number; total: number };
  /** 全体所要（durationMs）の中央値 (ms)。対象ゼロなら null。 */
  medianDurationMs: number | null;
  /** ステップ別ファネル（EXPERIENCE_STEP_ORDER 順）。 */
  funnel: ExperienceFunnelStep[];
  /** 入力手段別の利用数（測定済み受付のみ）。 */
  inputMethods: Record<ExperienceInputMethod, number>;
};

/** ゼロ値の KPI（空履歴・未接続時のプレースホルダに使う）。 */
export function emptyExperienceKpi(): ExperienceKpi {
  return {
    total: 0,
    measured: 0,
    callStartWithin30sRate: null,
    callStartWithin30s: { within: 0, reached: 0 },
    completionRate: null,
    completion: { connected: 0, total: 0 },
    medianDurationMs: null,
    funnel: EXPERIENCE_STEP_ORDER.map((step) => ({ step, reached: 0, abandoned: 0 })),
    inputMethods: { touch: 0, stt: 0, chat: 0, qr: 0 },
  };
}

/** experience が「到達した」最大ステップの index（未到達は -1）。ファネルの単調性を担保する。 */
function reachedIndex(exp: ReceptionExperience): number {
  let max = -1;
  const entered = new Set<ExperienceStep>();
  for (const key of Object.keys(exp.stepDurations ?? {}) as ExperienceStep[]) entered.add(key);
  if (exp.abandonedAtStep) entered.add(exp.abandonedAtStep);
  for (const step of entered) {
    const idx = EXPERIENCE_STEP_ORDER.indexOf(step);
    if (idx > max) max = idx;
  }
  return max;
}

/** 中央値（偶数個は中央 2 値の平均）。空は null。 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[mid] ?? null;
}

/**
 * 受付ログ集合から体験 KPI を集計する（期間非依存の純関数）。
 *
 * - 30 秒 KPI・ファネル・入力手段は experience を持つログのみを対象にする。
 * - 完遂率・中央値所要は outcome/durationMs が常に存在するため全ログを対象にする。
 */
export function summarizeExperience(logs: readonly ReceptionLog[]): ExperienceKpi {
  const kpi = emptyExperienceKpi();
  kpi.total = logs.length;

  const funnelReached = new Array(EXPERIENCE_STEP_ORDER.length).fill(0);
  const funnelAbandoned = new Array(EXPERIENCE_STEP_ORDER.length).fill(0);
  let within = 0;
  let reached = 0;
  let connected = 0;
  const durations: number[] = [];

  for (const log of logs) {
    if (log.outcome === 'connected') connected += 1;
    durations.push(log.durationMs);

    const exp = log.experience;
    if (!exp) continue;
    kpi.measured += 1;

    if (typeof exp.timeToCallMs === 'number') {
      reached += 1;
      if (exp.timeToCallMs <= CALL_START_TARGET_MS) within += 1;
    }

    if (exp.inputMethod) kpi.inputMethods[exp.inputMethod] += 1;

    const maxIdx = reachedIndex(exp);
    for (let i = 0; i <= maxIdx; i += 1) funnelReached[i] += 1;
    if (exp.abandonedAtStep) {
      const idx = EXPERIENCE_STEP_ORDER.indexOf(exp.abandonedAtStep);
      if (idx >= 0) funnelAbandoned[idx] += 1;
    }
  }

  kpi.callStartWithin30s = { within, reached };
  kpi.callStartWithin30sRate = reached > 0 ? within / reached : null;
  kpi.completion = { connected, total: logs.length };
  kpi.completionRate = logs.length > 0 ? connected / logs.length : null;
  kpi.medianDurationMs = median(durations);
  kpi.funnel = EXPERIENCE_STEP_ORDER.map((step, i) => ({
    step,
    reached: funnelReached[i],
    abandoned: funnelAbandoned[i],
  }));
  return kpi;
}
