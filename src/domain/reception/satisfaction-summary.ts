/**
 * ワンタップ満足度フィードバックの集計 (issue #320)。
 *
 * ReceptionLog（+ optional な satisfactionRating/feedbackReasonCodes）から、評価分布・
 * 終端状態（outcome）別内訳・理由コード別件数を導く純関数群。KPI 計測（#319）が「行動」の
 * 計測なのに対し、本モジュールは「感想」の集計を担う。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。期間フィルタは呼び出し側
 * （dashboard-summary の JST 暦日境界フィルタ）が行い、本モジュールは渡された（＝期間で
 * 絞り込み済みの）ログ集合に対して集計する（期間非依存）。
 *
 * PII 最小化: 集計対象・結果ともに評価値（列挙）・理由コード（列挙）・終端状態・件数のみ。
 * 来訪者 PII・自由記述は一切扱わない（構造的に存在しない）。
 */
import type { CallOutcome } from './session';
import type { FeedbackReasonCode, ReceptionLog, SatisfactionRating } from './log';

/** 表示順を固定する評価値の列挙（真実源）。 */
export const SATISFACTION_RATING_ORDER: readonly SatisfactionRating[] = ['happy', 'neutral', 'unhappy'];

/** 表示順を固定する理由コードの列挙（真実源）。 */
export const FEEDBACK_REASON_CODE_ORDER: readonly FeedbackReasonCode[] = [
  'waitTooLong',
  'hardToOperate',
  'staffUnavailable',
  'other',
];

const OUTCOMES: readonly CallOutcome[] = ['connected', 'timeout', 'failed', 'cancelled'];

/** 満足度フィードバックの集計結果。 */
export type SatisfactionSummary = {
  /** 集計対象の受付総数（全ログ）。 */
  total: number;
  /** フィードバックが送信された受付数（評価分布・内訳の母数）。 */
  responded: number;
  /** 評価値別件数。 */
  byRating: Record<SatisfactionRating, number>;
  /** 終端状態（outcome）別・評価値別件数。 */
  byOutcome: Record<CallOutcome, Record<SatisfactionRating, number>>;
  /** 理由コード別件数（複数選択可のため合計が responded と一致しないことがある）。 */
  byReasonCode: Record<FeedbackReasonCode, number>;
};

function emptyRatingRecord(): Record<SatisfactionRating, number> {
  return { happy: 0, neutral: 0, unhappy: 0 };
}

/** ゼロ値の集計結果（空履歴・未接続時のプレースホルダに使う）。 */
export function emptySatisfactionSummary(): SatisfactionSummary {
  const byOutcome = {} as Record<CallOutcome, Record<SatisfactionRating, number>>;
  for (const outcome of OUTCOMES) byOutcome[outcome] = emptyRatingRecord();
  const byReasonCode = {} as Record<FeedbackReasonCode, number>;
  for (const code of FEEDBACK_REASON_CODE_ORDER) byReasonCode[code] = 0;
  return {
    total: 0,
    responded: 0,
    byRating: emptyRatingRecord(),
    byOutcome,
    byReasonCode,
  };
}

/**
 * 受付ログ集合から満足度フィードバックの集計を導く（期間非依存の純関数）。
 * `satisfactionRating` が無いログは `total` にのみ計上する（未評価は分母から除外, 分子計算しない）。
 */
export function summarizeSatisfaction(logs: readonly ReceptionLog[]): SatisfactionSummary {
  const summary = emptySatisfactionSummary();
  summary.total = logs.length;

  for (const log of logs) {
    const rating = log.satisfactionRating;
    if (!rating) continue;
    summary.responded += 1;
    summary.byRating[rating] += 1;
    summary.byOutcome[log.outcome][rating] += 1;
    for (const code of log.feedbackReasonCodes ?? []) {
      summary.byReasonCode[code] += 1;
    }
  }

  return summary;
}
