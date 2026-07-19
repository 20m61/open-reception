/**
 * 音声評価の閾値 (SLO) とプロファイル (issue #365)。
 *
 * `tests/soak/thresholds.ts` (#317) と同じ形: モード（ここでは profile）ごとに閾値表を持ち、
 * 純関数で合否を判定する。実行環境の重さで 2 段構えにする:
 *
 * - `ci`  … 合成 fixture を使う軽量セット。毎回のゲートで回す。閾値は緩め（合成データの
 *           タイミングノイズで赤くしない）。回帰の**方向**を見るためのもの。
 * - `uat` … 実機・実 provider の完全セット (#65)。issue #365 の初期 SLO をそのまま使う。
 *
 * 初期 SLO は実機検証で更新する前提の暫定値であり、更新時は issue #365 と
 * `docs/voice-evaluation-harness.md` を併せて直すこと。
 */
import type { VoiceEvalSuiteMetrics } from './evaluation-metrics';

export type VoiceEvalThresholds = {
  /** UI 確定 partial までの P50 上限（ミリ秒）。 */
  stablePartialP50Ms: number;
  /** 明示的割り込み → 再生停止の P50 / P95 上限（ミリ秒）。 */
  bargeInStopP50Ms: number;
  bargeInStopP95Ms: number;
  /** 短答の speech end → first audio の P50 上限（ミリ秒）。 */
  shortAnswerFirstAudioP50Ms: number;
  /** 自由発話の speech end → first audio の P50 上限（ミリ秒）。 */
  freeFormFirstAudioP50Ms: number;
  /** 誤割り込み率（相づち・エコー・環境音での誤停止）の上限。 */
  maxFalseStopRate: number;
  /** 誤ターン終了率の上限。 */
  maxFalseCommitRate: number;
  /** 担当者候補 Top3 包含率の下限。 */
  minEntityTop3Rate: number;
};

export type VoiceEvalProfileName = 'ci' | 'uat';

export type VoiceEvalProfile = {
  name: VoiceEvalProfileName;
  description: string;
  thresholds: VoiceEvalThresholds;
  /** 計測不能な指標を FAIL にするか。実機セットでは計測欠落自体が異常。 */
  strict: boolean;
};

export const VOICE_EVAL_PROFILES: Record<VoiceEvalProfileName, VoiceEvalProfile> = {
  ci: {
    name: 'ci',
    description: '合成 fixture による軽量セット（毎回のローカル品質ゲートで実行）',
    thresholds: {
      stablePartialP50Ms: 600,
      bargeInStopP50Ms: 300,
      bargeInStopP95Ms: 600,
      shortAnswerFirstAudioP50Ms: 1000,
      freeFormFirstAudioP50Ms: 1800,
      maxFalseStopRate: 0.05,
      maxFalseCommitRate: 0.06,
      minEntityTop3Rate: 0.95,
    },
    strict: false,
  },
  uat: {
    name: 'uat',
    description: '実機・実 provider の完全セット（#65 の iPad 実機 UAT で実行）',
    thresholds: {
      stablePartialP50Ms: 300,
      bargeInStopP50Ms: 150,
      bargeInStopP95Ms: 300,
      shortAnswerFirstAudioP50Ms: 500,
      freeFormFirstAudioP50Ms: 900,
      maxFalseStopRate: 0.02,
      maxFalseCommitRate: 0.03,
      minEntityTop3Rate: 0.99,
    },
    strict: false,
  },
};

const DEFAULT_PROFILE: VoiceEvalProfileName = 'ci';

/** `VOICE_EVAL_PROFILE` env 等の解決。未指定/不正値は軽量な ci へ倒す（誤って重いセットを回さない）。 */
export function parseVoiceEvalProfile(raw: string | undefined): VoiceEvalProfile {
  const key = (raw ?? DEFAULT_PROFILE) as VoiceEvalProfileName;
  return VOICE_EVAL_PROFILES[key] ?? VOICE_EVAL_PROFILES[DEFAULT_PROFILE];
}

export type SloViolation = {
  metric: keyof VoiceEvalThresholds;
  observed: number | null;
  allowed: number;
  reason: string;
};

export type SloSkip = { metric: keyof VoiceEvalThresholds; reason: string };

export type SloResult = {
  passed: boolean;
  violations: SloViolation[];
  skipped: SloSkip[];
};

type Check = {
  metric: keyof VoiceEvalThresholds;
  label: string;
  observed: number | null;
  allowed: number;
  /** 'max' は上限（超えたら違反）、'min' は下限（下回ったら違反）。 */
  direction: 'max' | 'min';
};

function collectChecks(metrics: VoiceEvalSuiteMetrics, thresholds: VoiceEvalThresholds): Check[] {
  return [
    {
      metric: 'stablePartialP50Ms',
      label: 'UI 確定 partial 遅延 P50',
      observed: metrics.latency.audioOnsetToStablePartial.p50,
      allowed: thresholds.stablePartialP50Ms,
      direction: 'max',
    },
    {
      metric: 'bargeInStopP50Ms',
      label: '割り込み → 再生停止 P50',
      observed: metrics.latency.nearEndOnsetToPlaybackStopped.p50,
      allowed: thresholds.bargeInStopP50Ms,
      direction: 'max',
    },
    {
      metric: 'bargeInStopP95Ms',
      label: '割り込み → 再生停止 P95',
      observed: metrics.latency.nearEndOnsetToPlaybackStopped.p95,
      allowed: thresholds.bargeInStopP95Ms,
      direction: 'max',
    },
    {
      metric: 'shortAnswerFirstAudioP50Ms',
      label: '短答 speech end → first audio P50',
      observed: metrics.latency.speechEndToFirstAudioShortAnswer.p50,
      allowed: thresholds.shortAnswerFirstAudioP50Ms,
      direction: 'max',
    },
    {
      metric: 'freeFormFirstAudioP50Ms',
      label: '自由発話 speech end → first audio P50',
      observed: metrics.latency.speechEndToFirstAudioFreeForm.p50,
      allowed: thresholds.freeFormFirstAudioP50Ms,
      direction: 'max',
    },
    {
      metric: 'maxFalseStopRate',
      label: '誤割り込み率',
      observed: metrics.bargeIn.falseStopRate,
      allowed: thresholds.maxFalseStopRate,
      direction: 'max',
    },
    {
      metric: 'maxFalseCommitRate',
      label: '誤ターン終了率',
      observed: metrics.turn.falseCommitRate,
      allowed: thresholds.maxFalseCommitRate,
      direction: 'max',
    },
    {
      metric: 'minEntityTop3Rate',
      label: '担当者候補 Top3 包含率',
      observed: metrics.entity.top3Rate,
      allowed: thresholds.minEntityTop3Rate,
      direction: 'min',
    },
  ];
}

/**
 * スイート指標を SLO と突き合わせる。
 *
 * 計測できなかった指標（サンプル 0 件で `null`）は既定では `skipped` に入れて合否に影響させない。
 * `strict: true`（実機セット）では **計測不能自体を違反**として扱う — 計測が壊れた回で
 * 「違反 0 件だから緑」と誤読するのを防ぐ。
 */
export function evaluateAgainstSlo(
  metrics: VoiceEvalSuiteMetrics,
  thresholds: VoiceEvalThresholds,
  options: { strict?: boolean } = {},
): SloResult {
  const violations: SloViolation[] = [];
  const skipped: SloSkip[] = [];

  for (const check of collectChecks(metrics, thresholds)) {
    if (check.observed === null) {
      const reason = `${check.label}: 計測不能（該当サンプルが 0 件）`;
      if (options.strict) {
        violations.push({ metric: check.metric, observed: null, allowed: check.allowed, reason });
      } else {
        skipped.push({ metric: check.metric, reason });
      }
      continue;
    }

    const exceeded = check.direction === 'max' ? check.observed > check.allowed : check.observed < check.allowed;
    if (exceeded) {
      const comparator = check.direction === 'max' ? '上限' : '下限';
      violations.push({
        metric: check.metric,
        observed: check.observed,
        allowed: check.allowed,
        reason: `${check.label}: 実測 ${check.observed} が${comparator} ${check.allowed} を満たさない`,
      });
    }
  }

  return { passed: violations.length === 0, violations, skipped };
}
