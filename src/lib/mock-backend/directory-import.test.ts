import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDirectory,
  importDepartments,
  importStaff,
  listDepartments,
  listStaff,
} from './directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';

beforeEach(() => {
  __resetDirectory();
});

function recs(csv: string) {
  return parseCsvRecords(csv).records;
}

describe('importDepartments (#25)', () => {
  it('preview は件数を返し変更しない', () => {
    const before = listDepartments(true).length;
    const summary = importDepartments(recs('name\n法務部\n広報部'), 'preview');
    expect(summary.created).toBe(2);
    expect(listDepartments(true).length).toBe(before);
  });

  it('apply は新規部署を作成する', () => {
    importDepartments(recs('name,kana\n法務部,ほうむぶ'), 'apply');
    expect(listDepartments(true).some((d) => d.name === '法務部')).toBe(true);
  });

  it('既存 id は更新としてカウントする', () => {
    const summary = importDepartments(recs('department_id,name\ndept-sales,営業本部'), 'apply');
    expect(summary.updated).toBe(1);
    expect(listDepartments(true).find((d) => d.id === 'dept-sales')?.name).toBe('営業本部');
  });

  it('name が空の行は invalid', () => {
    const summary = importDepartments(recs('name,kana\n,ほげ'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });
});

describe('importStaff (#26)', () => {
  it('apply は新規担当者を作成する（aliases は ; 区切り）', () => {
    importStaff(recs('display_name,aliases,department_id\n新任 太郎,Taro;shinnin,dept-sales'), 'apply');
    const created = listStaff(true).find((s) => s.displayName === '新任 太郎');
    expect(created).toBeDefined();
    expect(created?.aliases).toEqual(['Taro', 'shinnin']);
  });

  it('未知の department_id は invalid', () => {
    const summary = importStaff(recs('display_name,department_id\n誰か,nope'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });

  it('display_name が空の行は invalid', () => {
    const summary = importStaff(recs('display_name,department_id\n,dept-sales'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });
});
