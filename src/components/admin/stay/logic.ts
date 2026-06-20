/**
 * 滞在状況 管理 UI の純ロジック (issue #102, increment 1)。
 *
 * 画面（StayManager）から副作用のない表示変換・集計・状態判定を切り出し、
 * node 環境のユニットテストで検証する。React/DOM には依存しない。
 *
 * PII は扱わない（VisitStay に PII は無い）。来訪者識別は参照（id/receptionId）のみ。
 */
import type { StatusKind } from '@/components/admin/ui/tokens';
import { elapsedMs, isOverstay } from '@/domain/visit/state';
import type { StayStatus, VisitStay } from '@/domain/visit/types';

/** 未退館（overstay）とみなす既定の滞在時間しきい値（8 時間）。 */
export const DEFAULT_OVERSTAY_THRESHOLD_MS = 8 * 60 * 60 * 1000;

/** 滞在状態 → StatusBadge の語彙（#92 表示ルール）へ写す。 */
export function statusKind(status: StayStatus): StatusKind {
  switch (status) {
    case 'present':
      return 'ok';
    case 'checked_out':
      return 'maintenance';
    case 'cancelled':
      return 'stopped';
  }
}

/** 滞在状態の日本語ラベル。 */
export function statusLabel(status: StayStatus): string {
  switch (status) {
    case 'present':
      return '在館中';
    case 'checked_out':
      return '退館済み';
    case 'cancelled':
      return '取消';
  }
}

/** 在館者に対して可能な操作を判定する純関数（present のみ退館/取消できる）。 */
export function availableActions(status: StayStatus): { canCheckout: boolean; canCancel: boolean } {
  return { canCheckout: status === 'present', canCancel: status === 'present' };
}

/** 滞在時間（ミリ秒）を「Xh Ym」表記へ整形する純関数。 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分`;
  return `${hours}時間${minutes}分`;
}

/** 在館中なら now まで、退館済みなら確定値の滞在時間表記。 */
export function durationText(stay: VisitStay, now: Date): string {
  if (stay.status === 'cancelled') return '—';
  return formatDuration(elapsedMs(stay, now));
}

export type StaySummary = {
  total: number;
  present: number;
  checkedOut: number;
  cancelled: number;
  overstay: number;
};

/**
 * 状態別件数 + 未退館件数を集計する純関数。
 * overstay は present のうち閾値超過分（派生表示）。
 */
export function summarize(
  stays: readonly VisitStay[],
  now: Date,
  overstayThresholdMs: number = DEFAULT_OVERSTAY_THRESHOLD_MS,
): StaySummary {
  const summary: StaySummary = { total: 0, present: 0, checkedOut: 0, cancelled: 0, overstay: 0 };
  for (const s of stays) {
    summary.total += 1;
    if (s.status === 'present') {
      summary.present += 1;
      if (isOverstay(s, now, overstayThresholdMs)) summary.overstay += 1;
    } else if (s.status === 'checked_out') {
      summary.checkedOut += 1;
    } else {
      summary.cancelled += 1;
    }
  }
  return summary;
}

/** 在館中 → その他、の順で、新しいチェックイン順に並べる純関数。 */
export function sortStays(stays: readonly VisitStay[]): VisitStay[] {
  const rank: Record<StayStatus, number> = { present: 0, checked_out: 1, cancelled: 2 };
  return [...stays].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return Date.parse(b.checkedInAt) - Date.parse(a.checkedInAt);
  });
}
