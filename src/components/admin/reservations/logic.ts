/**
 * 来訪予約 管理 UI の純ロジック (issue #97, increment 2)。
 *
 * 画面（ReservationsManager）から副作用のない表示変換・集計・状態判定を切り出し、
 * node 環境のユニットテストで検証する。React/DOM には依存しない。
 *
 * PII（visitorName/companyName/note）は表示にのみ使い、集計キーや監査には使わない。
 */
import type {
  ReservationStatus,
  ReservationUsagePolicy,
  VisitReservation,
} from '@/domain/reservation/types';
import type { StatusKind } from '@/components/admin/ui/tokens';

/** 予約ステータス → StatusBadge の語彙（#92 表示ルール）へ写す。 */
export function statusKind(status: ReservationStatus): StatusKind {
  switch (status) {
    case 'active':
      return 'ok';
    case 'used':
      return 'maintenance';
    case 'expired':
      return 'warning';
    case 'revoked':
      return 'critical';
    case 'cancelled':
      return 'stopped';
  }
}

/** 予約ステータスの日本語ラベル。 */
export function statusLabel(status: ReservationStatus): string {
  switch (status) {
    case 'active':
      return '有効';
    case 'used':
      return '使用済み';
    case 'expired':
      return '期限切れ';
    case 'revoked':
      return '失効';
    case 'cancelled':
      return 'キャンセル';
  }
}

/** 利用制約の日本語ラベル。 */
export function usagePolicyLabel(policy: ReservationUsagePolicy): string {
  return policy === 'single_use' ? '1 回利用' : '当日内利用';
}

/** 呼び出し先種別の日本語ラベル。 */
export function targetTypeLabel(targetType: VisitReservation['targetType']): string {
  return targetType === 'staff' ? '担当者' : '部署';
}

/**
 * 予約に対して可能な操作を判定する純関数。
 * - active のみ編集・キャンセルできる。
 * - active は失効でき、期限切れ/失効は再発行できる（applyReissue と整合）。
 * - QR 表示は終端でも可（受付端末側で利用可否を判定するため）。
 */
export function availableActions(status: ReservationStatus): {
  canEdit: boolean;
  canCancel: boolean;
  canRevoke: boolean;
  canReissue: boolean;
  canShowQr: boolean;
} {
  return {
    canEdit: status === 'active',
    canCancel: status === 'active',
    canRevoke: status === 'active',
    // #375: 生 token は保存されず QR は再表示できないため、有効(active)でも再発行を許す
    // (再発行は token ローテーション = 旧 QR は無効化。QR 紛失時の唯一の復旧手段)。
    canReissue: status === 'active' || status === 'expired' || status === 'revoked',
    canShowQr: true,
  };
}

/** 予約一覧のステータス別件数。ダッシュボード的な要約に使う。 */
export type ReservationSummary = Record<ReservationStatus, number> & { total: number };

/** ステータス別に集計する純関数（PII は集計に使わない）。 */
export function summarize(reservations: readonly VisitReservation[]): ReservationSummary {
  const summary: ReservationSummary = {
    active: 0,
    used: 0,
    expired: 0,
    revoked: 0,
    cancelled: 0,
    total: 0,
  };
  for (const r of reservations) {
    summary[r.status] += 1;
    summary.total += 1;
  }
  return summary;
}

/** visitAt の昇順（予定が近い順）。終端は末尾へ寄せず、純粋に日時順にする。 */
export function sortByVisitAt(
  reservations: readonly VisitReservation[],
): VisitReservation[] {
  return [...reservations].sort((a, b) => Date.parse(a.visitAt) - Date.parse(b.visitAt));
}

/** QR ダウンロード時のファイル名（PII を含めない。id と日付のみ）。 */
export function qrFileName(reservationId: string): string {
  const safeId = reservationId.replace(/[^A-Za-z0-9_-]/g, '');
  return `reservation-qr-${safeId}.svg`;
}
