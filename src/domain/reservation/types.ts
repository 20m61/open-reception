/**
 * 来訪予約ドメインの型 (issue #97, increment 1)。
 *
 * 管理画面で来訪予約を作成し、来訪者へ QR を発行するためのドメインモデル。
 * QR には個人情報を埋め込まず、サーバ側の予約を参照する推測困難な
 * `reservationToken` のみを載せる（docs/visit-reservation-design.md §セキュリティ）。
 *
 * このモジュールは純粋なドメイン型のみを定義し、外部 I/O は持たない。
 * テナント境界は #80 の型（TenantId / SiteId）に乗せ、認可判定は
 * src/domain/tenant/authorization.ts の純関数を呼び出し側で使う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** ブランド付き ID 型。予約 ID と来訪者識別子の混在を型で防ぐ。 */
export type ReservationId = string & { readonly __brand: 'ReservationId' };
export const asReservationId = (v: string): ReservationId => v as ReservationId;

/**
 * 来訪者へ渡すトークン。QR に載せる唯一の参照値で、十分なエントロピーを持つ
 * ランダム値（src/domain/reservation/token.ts で生成）。個人情報は含まない。
 *
 * 生値（平文）は**発行時に一度だけ**呼び出し側へ返す（`IssuedReservation`）。永続レコード
 * （`VisitReservation`）には平文を持たず、一方向 hash（`tokenHash`）のみを保存する（#375）。
 */
export type ReservationToken = string & { readonly __brand: 'ReservationToken' };
export const asReservationToken = (v: string): ReservationToken => v as ReservationToken;

/**
 * 予約トークンの一方向 hash（SHA-256 の 16 進表現・任意で server pepper 込み）。
 * 永続レコードにはこの hash のみを保存し、照合は入力 token を同様に hash して timing-safe
 * 比較する（src/domain/reservation/token.ts）。この値から生 token は復元できない（#375）。
 */
export type ReservationTokenHash = string & { readonly __brand: 'ReservationTokenHash' };
export const asReservationTokenHash = (v: string): ReservationTokenHash =>
  v as ReservationTokenHash;

/**
 * 予約の状態。
 * - active:   有効。QR を受付でスキャン可能。
 * - used:     使用済み。1 回利用制約により受付完了後に遷移。
 * - expired:  失効（有効期限切れ）。判定は純関数で行い、永続状態にも反映できる。
 * - revoked:  管理者が手動失効、または QR 再発行で旧予約/旧トークンを無効化した状態。
 * - cancelled: 来訪自体がキャンセルされた状態。
 */
export type ReservationStatus = 'active' | 'used' | 'expired' | 'revoked' | 'cancelled';

/** 来訪者が入力なしで受付できるよう、予約に紐づく呼び出し先。 */
export type ReservationTargetType = 'staff' | 'department';

/**
 * QR / トークンの利用制約。
 * - single_use: 1 回のみ利用可（受付完了で used へ）。
 * - same_day:   予定日（visitAt の日付）当日内のみ有効。当日内なら複数回読取可。
 */
export type ReservationUsagePolicy = 'single_use' | 'same_day';

/**
 * 来訪予約。
 *
 * PII の扱い:
 *   - visitorName / companyName / note は受付・取次に必要な最小限の PII。
 *     保存期間（retentionDays）を超えたら破棄する設計（運用は次増分の persistence で配線）。
 *   - これらは QR にも監査ログにも載せない（参照は token / id のみ）。
 */
export type VisitReservation = {
  id: ReservationId;
  /** テナント境界（必須）。他テナントの予約を参照させない。 */
  tenantId: TenantId;
  /** サイト境界（必須）。受付拠点ごとに分離する。 */
  siteId: SiteId;

  /** 来訪者氏名（PII）。 */
  visitorName: string;
  /** 会社名（任意・PII）。 */
  companyName?: string;
  /** 予定来訪日時（ISO 8601）。same_day 判定の基準。 */
  visitAt: string;
  /** 要件メモ（任意・PII になり得るため最小限）。 */
  note?: string;

  /** 呼び出し先の種別。 */
  targetType: ReservationTargetType;
  /** 呼び出し先 ID（staffId / departmentId）。 */
  targetId: string;

  /**
   * 来訪者トークンの一方向 hash（#375）。生 token は保存しない。受付照合は入力 token を
   * hash して timing-safe に突き合わせる。QR の再表示は不可（発行時のみ）。
   */
  tokenHash: ReservationTokenHash;
  /** 利用制約。 */
  usagePolicy: ReservationUsagePolicy;
  /** トークン有効期限（ISO 8601）。これを過ぎたら expired。 */
  expiresAt: string;

  status: ReservationStatus;
  /** 使用済みになった時刻（used 遷移時）。 */
  usedAt?: string;
  /** 予約 PII の保存期間（日数）。超過分は破棄する運用の根拠（増分2で配線）。 */
  retentionDays: number;

  createdAt: string;
  updatedAt: string;
};

/**
 * 発行結果（#375）。永続レコード（hash のみ）に、発行時だけ有効な生 token を添えた形。
 * `create` / `reissueToken` のみが返し、来訪者へ渡す QR / URL の生成に使う。get/list など
 * 通常の参照系は `VisitReservation`（hash のみ）を返し、生 token を再露出しない。
 */
export type IssuedReservation = VisitReservation & { token: ReservationToken };

/**
 * 移行前（#97 時点）の永続形（#375 移行対象）。生 token を保持し tokenHash を持たない。
 * `migrateReservationToHashed`（./migration.ts）で `VisitReservation` へ一括変換する。
 */
export type LegacyVisitReservation = Omit<VisitReservation, 'tokenHash'> & {
  token: ReservationToken;
};

/** 予約作成の入力（ドメイン用の正規化済み形）。 */
export type CreateReservationInput = {
  tenantId: TenantId;
  siteId: SiteId;
  visitorName: string;
  companyName?: string;
  visitAt: string;
  note?: string;
  targetType: ReservationTargetType;
  targetId: string;
  usagePolicy: ReservationUsagePolicy;
  /** 有効期限。省略時は呼び出し側が usagePolicy から導出する。 */
  expiresAt: string;
  retentionDays: number;
};

/** 予約編集で更新可能なフィールド（status / token は専用遷移で扱う）。 */
export type EditReservationPatch = {
  visitorName?: string;
  companyName?: string;
  visitAt?: string;
  note?: string;
  targetType?: ReservationTargetType;
  targetId?: string;
  usagePolicy?: ReservationUsagePolicy;
  expiresAt?: string;
  retentionDays?: number;
};

/** 状態の集合（判定ヘルパ用）。 */
export const TERMINAL_STATUSES: readonly ReservationStatus[] = [
  'used',
  'expired',
  'revoked',
  'cancelled',
];

export function isTerminal(status: ReservationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
