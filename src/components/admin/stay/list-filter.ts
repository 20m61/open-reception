/**
 * 在館状況一覧の検索・フィルタ・CSV 純関数 (issue #330 item2 残増分)。
 *
 * 受付履歴（`../receptions/logic.ts`）と同じ流儀で、絞り込み/CSV 変換を副作用なしに実装する。
 * VisitStay に PII は無いため（`@/domain/visit/types` 参照）、CSV にも PII は含まれない。
 */
import type { StayStatus, VisitStay } from '@/domain/visit/types';
import { jstEndBoundary, jstStartBoundary, toCsv } from '../list-io';
import { durationText, statusLabel } from './logic';

/** 在館状況一覧の検索条件。未指定（undefined）の項目は絞り込みに使わない。 */
export type StayListFilter = {
  /** チェックイン（checkedInAt）の期間開始（含む）。 */
  start?: string;
  /** チェックイン（checkedInAt）の期間終了（含む・JST 暦日の終わりまで）。 */
  end?: string;
  status?: StayStatus;
};

/** 滞在 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesStayFilter(stay: VisitStay, filter: StayListFilter): boolean {
  const at = new Date(stay.checkedInAt).getTime();

  if (filter.start) {
    const start = jstStartBoundary(filter.start);
    if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) return false;
  }
  if (filter.end) {
    const upper = jstEndBoundary(filter.end);
    if (!Number.isNaN(at) && at > upper) return false;
  }
  if (filter.status && stay.status !== filter.status) return false;
  return true;
}

/** 滞在配列をフィルタする（順序は入力のまま保持）。 */
export function filterStays(stays: readonly VisitStay[], filter: StayListFilter): VisitStay[] {
  return stays.filter((s) => matchesStayFilter(s, filter));
}

const CSV_HEADER = ['受付番号', '入館', '退館', '滞在時間', '状態'];

/** 滞在記録を CSV（ヘッダ行付き）へ変換する純関数。PII は含まれない（本ファイル冒頭コメント参照）。 */
export function staysToCsv(stays: readonly VisitStay[], now: Date): string {
  const rows = stays.map((s) => [
    s.id,
    s.checkedInAt,
    s.checkedOutAt ?? '',
    durationText(s, now),
    statusLabel(s.status),
  ]);
  return toCsv(CSV_HEADER, rows);
}
