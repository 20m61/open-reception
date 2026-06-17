/**
 * 担当者検索ロジック (issue #13)。
 * よみがな・別名・英字表記も対象にし、無効化された担当者は除外する。
 */
import type { Staff } from './types';

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/**
 * クエリに一致する有効な担当者を返す。
 * 空クエリの場合は有効な担当者を全件返す。
 */
export function searchStaff(staff: ReadonlyArray<Staff>, query: string): Staff[] {
  const enabled = staff.filter((s) => s.enabled);
  const q = normalize(query);
  if (q === '') {
    return [...enabled];
  }
  return enabled.filter((s) => {
    const haystack = [s.displayName, s.kana ?? '', ...s.aliases].map(normalize);
    return haystack.some((h) => h.includes(q));
  });
}
