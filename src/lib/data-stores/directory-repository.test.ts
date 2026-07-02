/**
 * DirectoryRepository の契約テスト（#274 ④: directory-store の repository 標準化）。
 *
 * §9.2（docs/persistence-design.md）の標準どおり、実装は getBackend() 委譲の 1 つだけ。
 * memory backend（DATA_BACKEND 既定）で round-trip と seed / reset の契約を検証する。
 * 検索・並び替え・入力検証の挙動は directory-store.test.ts / directory-import.test.ts が固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedDirectoryRepository } from './directory-repository';

afterEach(() => {
  __resetBackend();
});

const seedDepts: Department[] = [
  { id: 'dept-1', name: '総務', displayOrder: 1, enabled: true },
  { id: 'dept-2', name: '開発', displayOrder: 2, enabled: false },
];

const seedStaff: Staff[] = [
  {
    id: 'staff-1',
    displayName: '佐藤 太郎',
    aliases: [],
    departmentId: 'dept-1',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  },
];

function makeRepo(seed = true) {
  __resetBackend();
  return new DataBackedDirectoryRepository(
    seed ? () => seedDepts.map((d) => ({ ...d })) : undefined,
    seed ? () => seedStaff.map((s) => ({ ...s, aliases: [...s.aliases] })) : undefined,
  );
}

describe('DataBackedDirectoryRepository (#274 ④)', () => {
  it('seed が memory backend に投入され list で返る（enabled フィルタは呼び出し側の責務）', async () => {
    const repo = makeRepo();
    expect((await repo.listDepartments()).map((d) => d.id).sort()).toEqual(['dept-1', 'dept-2']);
    expect((await repo.listStaff()).map((s) => s.id)).toEqual(['staff-1']);
  });

  it('putDepartment → getDepartment が round-trip する', async () => {
    const repo = makeRepo(false);
    await repo.putDepartment({ id: 'd1', name: '営業', displayOrder: 1, enabled: true });
    expect(await repo.getDepartment('d1')).toMatchObject({ id: 'd1', name: '営業' });
    expect(await repo.getDepartment('nope')).toBeUndefined();
  });

  it('putStaff → getStaff が round-trip し、同一 id は上書きされる', async () => {
    const repo = makeRepo();
    const cur = await repo.getStaff('staff-1');
    await repo.putStaff({ ...cur!, available: false });
    expect((await repo.getStaff('staff-1'))?.available).toBe(false);
  });

  it('reset で部署・担当者の両方が seed 状態へ戻る（テスト導線）', async () => {
    const repo = makeRepo();
    await repo.putDepartment({ id: 'extra', name: '追加', displayOrder: 9, enabled: true });
    const staff = await repo.getStaff('staff-1');
    await repo.putStaff({ ...staff!, displayName: '変更 済' });
    await repo.reset();
    expect((await repo.listDepartments()).map((d) => d.id).sort()).toEqual(['dept-1', 'dept-2']);
    expect((await repo.getStaff('staff-1'))?.displayName).toBe('佐藤 太郎');
  });
});
