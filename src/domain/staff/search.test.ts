import { describe, expect, it } from 'vitest';
import { searchStaff } from './search';
import { MOCK_STAFF } from './mock-data';

describe('searchStaff', () => {
  it('表示名で検索できる', () => {
    const result = searchStaff(MOCK_STAFF, '佐藤');
    expect(result.map((s) => s.id)).toContain('staff-sato');
  });

  it('よみがなで検索できる', () => {
    const result = searchStaff(MOCK_STAFF, 'すずき');
    expect(result.map((s) => s.id)).toContain('staff-suzuki');
  });

  it('英字エイリアスで大文字小文字を無視して検索できる', () => {
    const result = searchStaff(MOCK_STAFF, 'tanaka');
    expect(result.map((s) => s.id)).toContain('staff-tanaka');
  });

  it('無効化された担当者は結果に含めない', () => {
    const result = searchStaff(MOCK_STAFF, '山田');
    expect(result).toHaveLength(0);
  });

  it('空クエリでは有効な担当者を全件返す', () => {
    const result = searchStaff(MOCK_STAFF, '   ');
    expect(result.every((s) => s.enabled)).toBe(true);
    expect(result).toHaveLength(MOCK_STAFF.filter((s) => s.enabled).length);
  });

  it('未ヒット時は空配列を返す（呼び出し側で代替導線を出す）', () => {
    expect(searchStaff(MOCK_STAFF, 'いない人')).toHaveLength(0);
  });
});
