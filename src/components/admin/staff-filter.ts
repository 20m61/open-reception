/**
 * 担当者一覧 検索・フィルタ純関数 (issue #330 item2)。
 *
 * 監査ログ・受付履歴（`src/domain/audit/audit-filter.ts` / `receptions/logic.ts`）と
 * 同じ流儀で、絞り込みロジックを副作用なしに切り出す。
 */
import type { Staff } from '@/domain/staff/types';

export type StaffStatusFilter = 'enabled' | 'disabled';

/** 担当者一覧の検索条件。未指定（undefined / 空文字）の項目は絞り込みに使わない。 */
export type StaffFilter = {
  /** 氏名・よみがなへの部分一致（大文字小文字を無視）。 */
  keyword?: string;
  /** 部署 ID の完全一致。 */
  departmentId?: string;
  /** 有効/無効。 */
  status?: StaffStatusFilter;
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** 担当者 1 件がフィルタ条件をすべて満たすか（純関数）。 */
export function matchesStaffFilter(staff: Staff, filter: StaffFilter): boolean {
  if (filter.keyword && filter.keyword.trim() !== '') {
    const needle = norm(filter.keyword);
    const haystack = norm(`${staff.displayName} ${staff.kana ?? ''}`);
    if (!haystack.includes(needle)) return false;
  }
  if (filter.departmentId && filter.departmentId.trim() !== '') {
    if (staff.departmentId !== filter.departmentId) return false;
  }
  if (filter.status) {
    const wantEnabled = filter.status === 'enabled';
    if (staff.enabled !== wantEnabled) return false;
  }
  return true;
}

/** 担当者配列をフィルタする（順序は入力のまま保持）。 */
export function filterStaff(staff: readonly Staff[], filter: StaffFilter): Staff[] {
  return staff.filter((s) => matchesStaffFilter(s, filter));
}
