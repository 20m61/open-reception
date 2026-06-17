import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDirectory,
  createDepartment,
  createStaff,
  getKioskDirectory,
  listDepartments,
  listStaff,
  moveDepartment,
  searchEnabledStaff,
  updateDepartment,
  updateStaff,
} from './directory-store';

beforeEach(() => {
  __resetDirectory();
});

describe('directory-store departments (#25)', () => {
  it('既定では無効な部署を除外する', () => {
    const enabled = listDepartments();
    expect(enabled.some((d) => d.id === 'dept-old')).toBe(false);
    expect(listDepartments(true).some((d) => d.id === 'dept-old')).toBe(true);
  });

  it('表示順でソートする', () => {
    const orders = listDepartments(true).map((d) => d.displayOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('部署を作成できる（既定で有効・末尾順）', () => {
    const r = createDepartment({ name: '法務部', kana: 'ほうむぶ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(true);
      expect(listDepartments(true).at(-1)?.id).toBe(r.value.id);
    }
  });

  it('空の部署名を拒否する', () => {
    const r = createDepartment({ name: '  ' });
    expect(r.ok).toBe(false);
  });

  it('部署を無効化できる', () => {
    updateDepartment('dept-sales', { enabled: false });
    expect(listDepartments().some((d) => d.id === 'dept-sales')).toBe(false);
  });

  it('部署を並び替えできる', () => {
    const before = listDepartments(true).map((d) => d.id);
    const second = before[1]!;
    moveDepartment(second, 'up');
    const after = listDepartments(true).map((d) => d.id);
    expect(after[0]).toBe(second);
  });
});

describe('directory-store staff (#26)', () => {
  it('既定では無効な担当者を除外する', () => {
    expect(listStaff().some((s) => s.id === 'staff-yamada')).toBe(false);
  });

  it('担当者を作成できる', () => {
    const r = createStaff({ displayName: '新人 一郎', departmentId: 'dept-sales' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(listStaff().some((s) => s.id === r.value.id)).toBe(true);
  });

  it('存在しない部署の担当者を拒否する', () => {
    const r = createStaff({ displayName: '誰か', departmentId: 'nope' });
    expect(r.ok).toBe(false);
  });

  it('担当者を無効化すると一覧から消える', () => {
    updateStaff('staff-sato', { enabled: false });
    expect(listStaff().some((s) => s.id === 'staff-sato')).toBe(false);
  });

  it('よみがなで検索できる', () => {
    expect(searchEnabledStaff('すずき').some((s) => s.id === 'staff-suzuki')).toBe(true);
  });
});

describe('kiosk directory view (#3)', () => {
  it('有効な部署・担当者のみ返す', () => {
    const dir = getKioskDirectory();
    expect(dir.departments.some((d) => d.id === 'dept-old')).toBe(false);
    expect(dir.staff.some((s) => s.id === 'staff-yamada')).toBe(false);
  });

  it('内部情報（mockCallOutcome）を含めない', () => {
    const serialized = JSON.stringify(getKioskDirectory());
    expect(serialized).not.toContain('mockCallOutcome');
    expect(serialized).not.toContain('no_answer');
  });

  it('検索に必要な kana / aliases は含める', () => {
    const sato = getKioskDirectory().staff.find((s) => s.id === 'staff-sato');
    expect(sato?.kana).toBeDefined();
    expect(Array.isArray(sato?.aliases)).toBe(true);
  });
});
