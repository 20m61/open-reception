import { describe, expect, it } from 'vitest';
import type { Staff } from '@/domain/staff/types';
import { filterStaff, type StaffFilter } from './staff-filter';

function fixture(overrides: Partial<Staff> = {}): Staff {
  return {
    id: 'staff-1',
    displayName: '佐藤 太郎',
    kana: 'さとう たろう',
    aliases: [],
    departmentId: 'dept-sales',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
    ...overrides,
  };
}

describe('filterStaff: 担当者一覧の検索・フィルタ純関数 (issue #330 item2)', () => {
  it('未指定条件は全件を返す', () => {
    const staff = [fixture(), fixture({ id: 'staff-2' })];
    expect(filterStaff(staff, {})).toHaveLength(2);
  });

  it('氏名・よみがなの部分一致（大文字小文字を無視）で絞り込む', () => {
    const staff = [
      fixture({ id: 'a', displayName: '佐藤 太郎', kana: 'さとう たろう' }),
      fixture({ id: 'b', displayName: '鈴木 花子', kana: 'すずき はなこ' }),
    ];
    expect(filterStaff(staff, { keyword: '佐藤' }).map((s) => s.id)).toEqual(['a']);
    expect(filterStaff(staff, { keyword: 'すずき' }).map((s) => s.id)).toEqual(['b']);
  });

  it('部署（departmentId）の完全一致で絞り込む', () => {
    const staff = [
      fixture({ id: 'a', departmentId: 'dept-sales' }),
      fixture({ id: 'b', departmentId: 'dept-dev' }),
    ];
    expect(filterStaff(staff, { departmentId: 'dept-dev' }).map((s) => s.id)).toEqual(['b']);
  });

  it('状態（有効/無効）で絞り込む', () => {
    const staff = [
      fixture({ id: 'a', enabled: true }),
      fixture({ id: 'b', enabled: false }),
    ];
    expect(filterStaff(staff, { status: 'enabled' }).map((s) => s.id)).toEqual(['a']);
    expect(filterStaff(staff, { status: 'disabled' }).map((s) => s.id)).toEqual(['b']);
  });

  it('条件は AND で組み合わさる', () => {
    const staff = [
      fixture({ id: 'a', departmentId: 'dept-sales', enabled: true }),
      fixture({ id: 'b', departmentId: 'dept-sales', enabled: false }),
      fixture({ id: 'c', departmentId: 'dept-dev', enabled: true }),
    ];
    const filter: StaffFilter = { departmentId: 'dept-sales', status: 'enabled' };
    expect(filterStaff(staff, filter).map((s) => s.id)).toEqual(['a']);
  });
});
