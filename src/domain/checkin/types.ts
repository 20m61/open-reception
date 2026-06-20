/**
 * QR チェックインのドメイン型 (issue #98, increment 1)。
 *
 * 予約サマリは確認画面で表示する**必要最小限**の情報のみを持つ。
 * reservationToken / note / 内部 id / retentionDays は含めない
 * （画面に長期有効値・余分な PII を残さない。docs/qr-checkin-design.md §3/§7）。
 */
import type { ReservationTargetType, ReservationUsagePolicy } from '@/domain/reservation/types';

/** 受付方法（QR 受付 / 通常受付）。受付履歴・監査に残す（PII ではない）。 */
export type CheckinEntryMethod = 'qr' | 'manual';

/** 確認画面に表示する予約サマリ（最小限）。 */
export type CheckinSummary = {
  /** 来訪者氏名（本人確認のため表示・PII 最小限）。 */
  visitorName: string;
  /** 会社名（任意）。 */
  companyName?: string;
  /** 予定来訪日時（ISO 8601）。 */
  visitAt: string;
  /** 呼び出し先種別。 */
  targetType: ReservationTargetType;
  /** 呼び出し先 ID（表示名は directory で解決）。 */
  targetId: string;
  /** 利用制約。 */
  usagePolicy: ReservationUsagePolicy;
};

/**
 * token 解決の失敗理由。受付端末が文言を出し分ける（受け入れ条件）。
 * - expired:    有効期限切れ / same_day の窓外。
 * - used:       使用済み（single_use）。
 * - revoked:    手動失効 / 再発行で旧トークン無効化。
 * - invalid:    payload が不正（token 取り出し不能・不正 QR）。
 * - not_found:  該当予約なし（誤読・他テナント）。
 */
export type CheckinFailureReason = 'expired' | 'used' | 'revoked' | 'invalid' | 'not_found';

/** token 解決の結果（使用済み化はしない・閲覧のみ）。 */
export type ResolveResult =
  | { ok: true; summary: CheckinSummary }
  | { ok: false; reason: CheckinFailureReason };
