/**
 * 危険操作 UX の **振る舞い**（確認フロー）を表す純ロジック (issue #91, increment 1)。
 *
 * 視覚的な器（DangerZone のスタイル等）は #92 の `components/admin/ui/` が別途作る。ここは
 * 名前衝突を避けつつ「二段確認・理由入力・確認文言入力」の状態遷移と検証だけを純関数で
 * 提供する。React 非依存なので node 環境の vitest でそのままテストできる。
 *
 * フロー（要求に応じて段階を増減できる）:
 *   idle → reviewing（影響範囲を提示）→ confirming（理由 + 確認文言入力）→ ready（実行可）
 */

/** 確認フローの要件。操作ごとに必要な確認段階を宣言する。 */
export type ConfirmRequirement = {
  /** 影響範囲の確認（チェック）を求めるか。 */
  requireImpactAck: boolean;
  /** 操作理由の入力を求めるか。 */
  requireReason: boolean;
  /** 理由の最小文字数（requireReason 時のみ）。既定 4。 */
  minReasonLength?: number;
  /**
   * 確認文言（ユーザーがタイプして一致させる文字列）。未指定なら確認文言入力を求めない。
   * 例: テナント名・'DELETE' など。
   */
  confirmationPhrase?: string;
};

/** ユーザー入力の現在値。 */
export type ConfirmInput = {
  impactAcknowledged: boolean;
  reason: string;
  typedPhrase: string;
};

/** 検証で見つかった不足（理由つき）。空配列なら実行可能。 */
export type ConfirmIssue =
  | 'impact-not-acknowledged'
  | 'reason-required'
  | 'reason-too-short'
  | 'phrase-mismatch';

export const EMPTY_INPUT: ConfirmInput = {
  impactAcknowledged: false,
  reason: '',
  typedPhrase: '',
};

const DEFAULT_MIN_REASON = 4;

/** 確認入力を要件に対して検証し、未充足の項目（issues）を返す。 */
export function validateConfirm(
  req: ConfirmRequirement,
  input: ConfirmInput,
): ConfirmIssue[] {
  const issues: ConfirmIssue[] = [];

  if (req.requireImpactAck && !input.impactAcknowledged) {
    issues.push('impact-not-acknowledged');
  }

  if (req.requireReason) {
    const reason = input.reason.trim();
    if (reason.length === 0) {
      issues.push('reason-required');
    } else if (reason.length < (req.minReasonLength ?? DEFAULT_MIN_REASON)) {
      issues.push('reason-too-short');
    }
  }

  if (req.confirmationPhrase !== undefined) {
    // 前後空白は許容するが大文字小文字は厳密一致（'DELETE' など）。
    if (input.typedPhrase.trim() !== req.confirmationPhrase.trim()) {
      issues.push('phrase-mismatch');
    }
  }

  return issues;
}

/** 要件をすべて満たし、危険操作を実行してよいか。 */
export function canConfirm(req: ConfirmRequirement, input: ConfirmInput): boolean {
  return validateConfirm(req, input).length === 0;
}

/**
 * 監査用に渡せる正規化済み理由を返す（trim 済み）。requireReason かつ未充足なら null。
 * recordDangerAction の reason へ渡すことを想定。機微値・PII は呼び出し側で含めない。
 */
export function normalizedReason(
  req: ConfirmRequirement,
  input: ConfirmInput,
): string | null {
  if (!req.requireReason) return input.reason.trim() || null;
  const reason = input.reason.trim();
  return reason.length >= (req.minReasonLength ?? DEFAULT_MIN_REASON) ? reason : null;
}
