import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDirectory,
  importDepartments,
  importStaff,
  listDepartments,
  listStaff,
} from './directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';

beforeEach(async () => {
  await __resetDirectory();
});

function recs(csv: string) {
  return parseCsvRecords(csv).records;
}

describe('importDepartments (#25)', () => {
  it('preview は件数を返し変更しない', async () => {
    const before = (await listDepartments(true)).length;
    const summary = await importDepartments(recs('name\n法務部\n広報部'), 'preview');
    expect(summary.created).toBe(2);
    expect((await listDepartments(true)).length).toBe(before);
  });

  it('apply は新規部署を作成する', async () => {
    await importDepartments(recs('name,kana\n法務部,ほうむぶ'), 'apply');
    expect((await listDepartments(true)).some((d) => d.name === '法務部')).toBe(true);
  });

  it('既存 id は更新としてカウントする', async () => {
    const summary = await importDepartments(recs('department_id,name\ndept-sales,営業本部'), 'apply');
    expect(summary.updated).toBe(1);
    expect((await listDepartments(true)).find((d) => d.id === 'dept-sales')?.name).toBe('営業本部');
  });

  it('name が空の行は invalid', async () => {
    const summary = await importDepartments(recs('name,kana\n,ほげ'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });
});

describe('importStaff (#26)', () => {
  it('apply は新規担当者を作成する（aliases は ; 区切り）', async () => {
    await importStaff(recs('display_name,aliases,department_id\n新任 太郎,Taro;shinnin,dept-sales'), 'apply');
    const created = (await listStaff(true)).find((s) => s.displayName === '新任 太郎');
    expect(created).toBeDefined();
    expect(created?.aliases).toEqual(['Taro', 'shinnin']);
  });

  it('未知の department_id は invalid', async () => {
    const summary = await importStaff(recs('display_name,department_id\n誰か,nope'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });

  it('display_name が空の行は invalid', async () => {
    const summary = await importStaff(recs('display_name,department_id\n,dept-sales'), 'preview');
    expect(summary.invalid.length).toBe(1);
  });
});
