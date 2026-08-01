import { beforeEach, describe, expect, it } from 'vitest';
import {

  __resetDirectory,
  createDepartment,
  createStaff,
  getKioskDirectory,
  listDepartments,
  listStaff,
  moveDepartment,
  reorderDepartments,
  searchEnabledStaff,
  updateDepartment,
  updateStaff,
} from './directory-store';

const T = 'internal';

beforeEach(async () => {
  await __resetDirectory(T);
});

describe('directory-store departments (#25)', () => {
  it('既定では無効な部署を除外する', async () => {
    const enabled = await listDepartments(T);
    expect(enabled.some((d) => d.id === 'dept-old')).toBe(false);
    expect((await listDepartments(T, true)).some((d) => d.id === 'dept-old')).toBe(true);
  });

  it('表示順でソートする', async () => {
    const orders = (await listDepartments(T, true)).map((d) => d.displayOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('部署を作成できる（既定で有効・末尾順）', async () => {
    const r = await createDepartment(T, { name: '法務部', kana: 'ほうむぶ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.enabled).toBe(true);
      expect((await listDepartments(T, true)).at(-1)?.id).toBe(r.value.id);
    }
  });

  it('空の部署名を拒否する', async () => {
    const r = await createDepartment(T, { name: '  ' });
    expect(r.ok).toBe(false);
  });

  it('部署を無効化できる', async () => {
    await updateDepartment(T, 'dept-sales', { enabled: false });
    expect((await listDepartments(T)).some((d) => d.id === 'dept-sales')).toBe(false);
  });

  it('部署を並び替えできる', async () => {
    const before = (await listDepartments(T, true)).map((d) => d.id);
    const second = before[1]!;
    await moveDepartment(T, second, 'up');
    const after = (await listDepartments(T, true)).map((d) => d.id);
    expect(after[0]).toBe(second);
  });

  it('DnD 順序で一括並び替えできる', async () => {
    const ids = (await listDepartments(T, true)).map((d) => d.id);
    const reversed = [...ids].reverse();
    const r = await reorderDepartments(T, reversed);
    expect(r.ok).toBe(true);
    expect((await listDepartments(T, true)).map((d) => d.id)).toEqual(reversed);
  });

  it('未知 id を含む並び替えは拒否する', async () => {
    expect((await reorderDepartments(T, ['nope'])).ok).toBe(false);
  });
});

describe('directory-store staff (#26)', () => {
  it('既定では無効な担当者を除外する', async () => {
    expect((await listStaff(T)).some((s) => s.id === 'staff-yamada')).toBe(false);
  });

  it('担当者を作成できる', async () => {
    const r = await createStaff(T, { displayName: '新人 一郎', departmentId: 'dept-sales' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((await listStaff(T)).some((s) => s.id === r.value.id)).toBe(true);
  });

  it('存在しない部署の担当者を拒否する', async () => {
    const r = await createStaff(T, { displayName: '誰か', departmentId: 'nope' });
    expect(r.ok).toBe(false);
  });

  it('担当者を無効化すると一覧から消える', async () => {
    await updateStaff(T, 'staff-sato', { enabled: false });
    expect((await listStaff(T)).some((s) => s.id === 'staff-sato')).toBe(false);
  });

  it('よみがなで検索できる', async () => {
    expect((await searchEnabledStaff(T, 'すずき')).some((s) => s.id === 'staff-suzuki')).toBe(true);
  });
});

describe('kiosk directory view (#3)', () => {
  it('有効な部署・担当者のみ返す', async () => {
    const dir = await getKioskDirectory(T);
    expect(dir.departments.some((d) => d.id === 'dept-old')).toBe(false);
    expect(dir.staff.some((s) => s.id === 'staff-yamada')).toBe(false);
  });

  it('内部情報（mockCallOutcome）を含めない', async () => {
    const serialized = JSON.stringify(await getKioskDirectory(T));
    expect(serialized).not.toContain('mockCallOutcome');
    expect(serialized).not.toContain('no_answer');
  });

  it('在席状態(available)を含み、不在担当者も有効なら一覧に出る', async () => {
    const ono = (await getKioskDirectory(T)).staff.find((s) => s.id === 'staff-ono');
    expect(ono).toBeDefined();
    expect(ono?.available).toBe(false);
  });

  it('検索に必要な kana / aliases は含める', async () => {
    const sato = (await getKioskDirectory(T)).staff.find((s) => s.id === 'staff-sato');
    expect(sato?.kana).toBeDefined();
    expect(Array.isArray(sato?.aliases)).toBe(true);
  });
});

/** テナント別に分離されていること (#419 残増分)。 */
describe('directory-store のテナント分離 (#419)', () => {
  it('別テナントには作成した部署が見えない', async () => {
    await __resetDirectory('acme');
    const r = await createDepartment(T, { name: '総務部' });
    if (!r.ok) throw new Error('fixture failed');

    expect((await listDepartments(T)).some((d) => d.id === r.value.id)).toBe(true);
    expect((await listDepartments('acme')).some((d) => d.id === r.value.id)).toBe(false);
  });

  it('別テナントには作成した担当者が見えない', async () => {
    await __resetDirectory('acme');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const s = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!s.ok) throw new Error('fixture failed');

    expect((await listStaff(T)).some((m) => m.id === s.value.id)).toBe(true);
    expect((await listStaff('acme')).some((m) => m.id === s.value.id)).toBe(false);
  });
});
