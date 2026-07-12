/**
 * 滞在状態ドメインの型 (issue #102, increment 1)。
 *
 * 来訪者の在館 / 退館を表す純粋なドメインモデル。外部 I/O は持たない。
 * テナント境界は #80 の型（TenantId / SiteId）に乗せ、認可判定は
 * src/domain/tenant/authorization.ts の純関数を呼び出し側で使う。
 *
 * PII の扱い（docs/checkout-stay-design.md §3）:
 *   - VisitStay には氏名・会社名・メモなどの PII を **保存しない**。
 *     来訪者の識別は予約 token / 受付セッション（receptionId）/ 受付番号（stayId）の
 *     **参照** で行う。QR にも監査ログにも PII を載せない。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** ブランド付き ID 型。滞在 ID と他 ID の混在を型で防ぐ。 */
export type StayId = string & { readonly __brand: 'StayId' };
export const asStayId = (v: string): StayId => v as StayId;

/**
 * 滞在状態。
 * - present:      在館中（チェックイン完了）。
 * - checked_out: 退館済み（退館チェックアウト完了）。終端。
 * - cancelled:   取消（誤登録の訂正）。終端。滞在実績として数えない。
 *
 * 「未退館（overstay）」は独立した永続状態ではなく、present かつ一定時間経過の
 * 派生表示として扱う（isOverstay）。状態を増やさず閾値変更を容易にする。
 */
export type StayStatus = 'present' | 'checked_out' | 'cancelled';

/**
 * 来訪者の滞在記録。
 *
 * 来訪者識別は参照のみ（reservationId / receptionId / stayId）。
 * 氏名・会社名・メモは保存しない（docs/checkout-stay-design.md §3）。
 */
export type VisitStay = {
  id: StayId;
  /** テナント境界（必須）。他テナントの滞在を参照させない。 */
  tenantId: TenantId;
  /** サイト境界（必須）。受付拠点ごとに分離する。 */
  siteId: SiteId;

  status: StayStatus;
  /** 在館の起点（ISO 8601）。チェックイン時刻。 */
  checkedInAt: string;
  /** 退館時刻（ISO 8601、checked_out 遷移時に確定）。 */
  checkedOutAt?: string;
  /** 滞在時間（ミリ秒、退館時に確定）。 */
  durationMs?: number;

  /** 予約から来館した場合の参照（#97）。PII ではない。 */
  reservationId?: string;
  /** 受付セッション参照（#16）。PII ではない。 */
  receptionId?: string;

  /**
   * 呼び出し先ラベル（部署名・担当者の表示名。氏名そのものではない）(issue #328)。
   * 在館一覧の判別材料・退館確認ステップの表示に使う非 PII 情報。
   */
  targetLabel?: string;
  /**
   * 用件（来訪目的種別のラベル）(issue #328)。在館一覧・確認ステップの判別材料（非 PII）。
   */
  purpose?: string;

  /** 滞在情報の保存期間（日数）。超過分は破棄する運用の根拠（docs §4）。 */
  retentionDays: number;

  createdAt: string;
  updatedAt: string;
};

/** 滞在記録作成の入力（正規化済み）。PII は含めない。 */
export type CreateStayInput = {
  tenantId: TenantId;
  siteId: SiteId;
  /** 在館起点。省略時は呼び出し側で now を使う。 */
  checkedInAt?: string;
  reservationId?: string;
  receptionId?: string;
  /** 呼び出し先ラベル（非 PII、#328）。判別材料・退館確認用。 */
  targetLabel?: string;
  /** 用件（非 PII、#328）。 */
  purpose?: string;
  retentionDays?: number;
};

/** 終端状態の集合（前進する遷移がない）。 */
export const TERMINAL_STAY_STATUSES: readonly StayStatus[] = ['checked_out', 'cancelled'];

export function isTerminalStay(status: StayStatus): boolean {
  return TERMINAL_STAY_STATUSES.includes(status);
}

/** 既知の滞在状態かの型ガード。 */
export function isStayStatus(value: unknown): value is StayStatus {
  return value === 'present' || value === 'checked_out' || value === 'cancelled';
}
