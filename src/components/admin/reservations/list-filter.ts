/**
 * 来訪予約一覧の検索・フィルタ・CSV 純関数 (issue #330 item2 残増分)。
 *
 * 受付履歴（`../receptions/logic.ts`）と同じ流儀で、絞り込み/CSV 変換を副作用なしに実装する。
 * CSV は来訪者名・会社名・メモ等の PII を含めない（`types.ts` の設計方針: 「QR にも監査ログにも
 * 載せない」と同じ最小化を、ダウンロード可能な CSV エクスポートにも適用する。表示テーブル自体は
 * 既存どおり氏名を表示するが、ファイルとして残る CSV は運用に必要な非 PII 項目のみに絞る）。
 */
import type { ReservationStatus, ReservationTargetType, VisitReservation } from '@/domain/reservation/types';
import { jstEndBoundary, jstStartBoundary, toCsv } from '../list-io';
import { statusLabel, targetTypeLabel, usagePolicyLabel } from './logic';

/** 来訪予約一覧の検索条件。未指定（undefined）の項目は絞り込みに使わない。 */
export type ReservationListFilter = {
  /** 予定日時（visitAt）の期間開始（含む）。 */
  start?: string;
  /** 予定日時（visitAt）の期間終了（含む・JST 暦日の終わりまで）。 */
  end?: string;
  status?: ReservationStatus;
  targetType?: ReservationTargetType;
};

/** 予約 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesReservationFilter(
  reservation: VisitReservation,
  filter: ReservationListFilter,
): boolean {
  const at = new Date(reservation.visitAt).getTime();

  if (filter.start) {
    const start = jstStartBoundary(filter.start);
    if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) return false;
  }
  if (filter.end) {
    const upper = jstEndBoundary(filter.end);
    if (!Number.isNaN(at) && at > upper) return false;
  }
  if (filter.status && reservation.status !== filter.status) return false;
  if (filter.targetType && reservation.targetType !== filter.targetType) return false;
  return true;
}

/** 予約配列をフィルタする（順序は入力のまま保持）。 */
export function filterReservations(
  reservations: readonly VisitReservation[],
  filter: ReservationListFilter,
): VisitReservation[] {
  return reservations.filter((r) => matchesReservationFilter(r, filter));
}

const CSV_HEADER = ['予定日時', '呼び出し先種別', '呼び出し先ID', '利用制約', '状態', '有効期限'];

/**
 * 来訪予約を CSV（ヘッダ行付き）へ変換する純関数。
 * 来訪者名・会社名・メモ（PII）は含めない（本ファイル冒頭コメント参照）。
 */
export function reservationsToCsv(reservations: readonly VisitReservation[]): string {
  const rows = reservations.map((r) => [
    r.visitAt,
    targetTypeLabel(r.targetType),
    r.targetId,
    usagePolicyLabel(r.usagePolicy),
    statusLabel(r.status),
    r.expiresAt,
  ]);
  return toCsv(CSV_HEADER, rows);
}
