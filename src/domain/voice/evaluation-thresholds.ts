/**
 * 音声評価の閾値 (SLO) とプロファイル (issue #365)。
 *
 * `tests/soak/thresholds.ts` (#317) と同じ形: モード（ここでは profile）ごとに閾値表を持ち、
 * 純関数で合否を判定する。実行環境の重さで 2 段構えにする:
 *
 * - `ci`  … 合成 fixture を使う軽量セット。毎回のゲートで回す。閾値は緩め（合成データの
 *           タイミングノイズで赤くしない）。回帰の**方向**を見るためのもの。
 * - `uat` … 実機・実 provider の完全セット (#65)。issue #365 の初期 SLO をそのまま使い、
 *           計測欠落も違反として扱う（`strict: true`）。
 *
 * **SLO セットは対称であること。** false positive（誤停止・誤終了）だけを罰して false negative
 * （検出漏れ・終了見逃し）を罰さないと、「何もしない provider」が最も安く緑になる。
 * 停止・確定・解決の各指標には必ず**下限**（検出率）と**上限**（誤り率）を対で置く。
 *
 * 初期 SLO は実機検証で更新する前提の暫定値であり、更新時は issue #365 と
 * `docs/voice-evaluation-harness.md` を併せて直すこと。
 */
import type { VoiceEvalSuiteMetrics } from './evaluation-metrics';

export type VoiceEvalThresholds = {
  // --- 遅延（上限） ---
  /** UI 確定 partial までの P50 上限（ミリ秒）。 */
  stablePartialP50Ms: number;
  /** 明示的割り込み → 再生停止の P50 / P95 上限（ミリ秒）。 */
  bargeInStopP50Ms: number;
  bargeInStopP95Ms: number;
  /** 短答の speech end → first audio の P50 上限（ミリ秒）。 */
  shortAnswerFirstAudioP50Ms: number;
  /** 自由発話の speech end → first audio の P50 上限（ミリ秒）。 */
  freeFormFirstAudioP50Ms: number;
  /** 音声と口形の同期誤差 P50 上限（ミリ秒）。 */
  visemeSyncErrorP50Ms: number;

  // --- 割り込み（上限と下限の対） ---
  /** 誤割り込み率（相づち・エコー・環境音での誤停止）の上限。 */
  maxFalseStopRate: number;
  /** 真の割り込みを検出して止められた割合の下限。これが無いと「絶対に止めない」が緑になる。 */
  minTrueInterruptionDetectionRate: number;
  /** 近端発話を onset として拾えた割合の下限。VAD の検出漏れを罰する。 */
  minNearEndOnsetDetectionRate: number;
  /**
   * 原因の onset を特定できなかった `barge_in` 停止の割合の上限。
   * これが無いと、反応窓より遅い停止が「検出漏れ 1 件」に化け、
   * `minTrueInterruptionDetectionRate` の余裕（ci 10% / uat 2%）に吸収されて緑になる。
   */
  maxUnattributedBargeInStopRate: number;

  // --- ターン（上限と下限の対） ---
  /** 誤ターン終了率の上限。 */
  maxFalseCommitRate: number;
  /** 終了見逃し率の上限。これが無いと「絶対に確定しない」が緑になる。 */
  maxMissedEndRate: number;

  // --- 精度 ---
  /** コーパス CER の上限（発話ごとの中央値ではなく総編集距離 / 総文字数）。 */
  maxCorpusCer: number;
  /** 人名の包含一致率の下限。 */
  minPersonNameExactMatchRate: number;
  /** 部門名の包含一致率の下限。 */
  minDepartmentNameExactMatchRate: number;
  /** 担当者候補 Top3 包含率の下限。 */
  minEntityTop3Rate: number;

  // --- 信頼性 ---
  /** 途中終了セッションの割合の上限。失敗を「イベントが少ないだけ」に見せない。 */
  maxAbortedSessionRate: number;
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
      visemeSyncErrorP50Ms: 100,
      maxFalseStopRate: 0.05,
      minTrueInterruptionDetectionRate: 0.9,
      minNearEndOnsetDetectionRate: 0.85,
      maxUnattributedBargeInStopRate: 0,
      maxFalseCommitRate: 0.06,
      maxMissedEndRate: 0.06,
      maxCorpusCer: 0.1,
      minPersonNameExactMatchRate: 0.9,
      minDepartmentNameExactMatchRate: 0.9,
      minEntityTop3Rate: 0.95,
      maxAbortedSessionRate: 0,
    },
    // 合成 fixture は網羅しきらない切り口があるため、計測不能は skipped に留める。
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
      visemeSyncErrorP50Ms: 50,
      maxFalseStopRate: 0.02,
      minTrueInterruptionDetectionRate: 0.98,
      minNearEndOnsetDetectionRate: 0.95,
      maxUnattributedBargeInStopRate: 0,
      maxFalseCommitRate: 0.03,
      maxMissedEndRate: 0.03,
      maxCorpusCer: 0.05,
      minPersonNameExactMatchRate: 0.98,
      minDepartmentNameExactMatchRate: 0.95,
      minEntityTop3Rate: 0.99,
      maxAbortedSessionRate: 0,
    },
    // 実機セットでは「計測できなかった」こと自体が配線の欠落 = 異常。緑にしない。
    strict: true,
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
  const { latency, stt, turn, bargeIn, entity, reliability } = metrics;
  return [
    {
      metric: 'stablePartialP50Ms',
      label: 'UI 確定 partial 遅延 P50',
      observed: latency.audioOnsetToStablePartial.p50,
      allowed: thresholds.stablePartialP50Ms,
      direction: 'max',
    },
    {
      metric: 'bargeInStopP50Ms',
      label: '割り込み → 再生停止 P50',
      observed: latency.nearEndOnsetToPlaybackStopped.p50,
      allowed: thresholds.bargeInStopP50Ms,
      direction: 'max',
    },
    {
      metric: 'bargeInStopP95Ms',
      label: '割り込み → 再生停止 P95',
      observed: latency.nearEndOnsetToPlaybackStopped.p95,
      allowed: thresholds.bargeInStopP95Ms,
      direction: 'max',
    },
    {
      metric: 'shortAnswerFirstAudioP50Ms',
      label: '短答 speech end → first audio P50',
      observed: latency.speechEndToFirstAudioShortAnswer.p50,
      allowed: thresholds.shortAnswerFirstAudioP50Ms,
      direction: 'max',
    },
    {
      metric: 'freeFormFirstAudioP50Ms',
      label: '自由発話 speech end → first audio P50',
      observed: latency.speechEndToFirstAudioFreeForm.p50,
      allowed: thresholds.freeFormFirstAudioP50Ms,
      direction: 'max',
    },
    {
      metric: 'visemeSyncErrorP50Ms',
      label: '音声と viseme の同期誤差 P50',
      observed: latency.visemeSyncError.p50,
      allowed: thresholds.visemeSyncErrorP50Ms,
      direction: 'max',
    },
    {
      metric: 'maxFalseStopRate',
      label: '誤割り込み率',
      observed: bargeIn.falseStopRate,
      allowed: thresholds.maxFalseStopRate,
      direction: 'max',
    },
    {
      metric: 'minTrueInterruptionDetectionRate',
      label: '真の割り込みの検出率',
      observed: bargeIn.trueInterruptionDetectionRate,
      allowed: thresholds.minTrueInterruptionDetectionRate,
      direction: 'min',
    },
    {
      metric: 'minNearEndOnsetDetectionRate',
      label: '近端発話の onset 検出率',
      observed: bargeIn.nearEndOnsetDetectionRate,
      allowed: thresholds.minNearEndOnsetDetectionRate,
      direction: 'min',
    },
    {
      metric: 'maxUnattributedBargeInStopRate',
      label: '原因を特定できなかった再生停止の割合',
      observed: bargeIn.unattributedStopRate,
      allowed: thresholds.maxUnattributedBargeInStopRate,
      direction: 'max',
    },
    {
      metric: 'maxFalseCommitRate',
      label: '誤ターン終了率',
      observed: turn.falseCommitRate,
      allowed: thresholds.maxFalseCommitRate,
      direction: 'max',
    },
    {
      metric: 'maxMissedEndRate',
      label: 'ターン終了見逃し率',
      observed: turn.missedEndRate,
      allowed: thresholds.maxMissedEndRate,
      direction: 'max',
    },
    {
      metric: 'maxCorpusCer',
      label: 'コーパス CER',
      observed: stt.corpusCer,
      allowed: thresholds.maxCorpusCer,
      direction: 'max',
    },
    {
      metric: 'minPersonNameExactMatchRate',
      label: '人名の一致率',
      observed: stt.personNameExactMatchRate,
      allowed: thresholds.minPersonNameExactMatchRate,
      direction: 'min',
    },
    {
      metric: 'minDepartmentNameExactMatchRate',
      label: '部門名の一致率',
      observed: stt.departmentNameExactMatchRate,
      allowed: thresholds.minDepartmentNameExactMatchRate,
      direction: 'min',
    },
    {
      metric: 'minEntityTop3Rate',
      label: '担当者候補 Top3 包含率',
      observed: entity.top3Rate,
      allowed: thresholds.minEntityTop3Rate,
      direction: 'min',
    },
    {
      metric: 'maxAbortedSessionRate',
      label: '途中終了セッション率',
      observed: reliability.abortedSessionRate,
      allowed: thresholds.maxAbortedSessionRate,
      direction: 'max',
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
