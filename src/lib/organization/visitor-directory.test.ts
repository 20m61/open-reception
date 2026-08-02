import { beforeEach, describe, expect, it } from 'vitest';
import { getVisitorDirectory } from './organization-service';
import { __resetOrganization, putOrganizationUnit } from './organization-repository';
import {
  __resetDirectory,
  createDepartment,
  createStaff,
  getKioskDirectory,
  updateDepartment,
} from '@/lib/data-stores/directory-store';
import { getOrganizationView } from './organization-service';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

/**
 * 来訪者向けディレクトリを組織モデルから導出する (#373 増分 4)。
 *
 * ## ここで固定したい判断（規則 A・2026-08-02 ユーザー判断）
 *
 * **無効な組織に所属する担当者は、来訪者から呼べるまま。** 現行の `getKioskDirectory` が
 * 担当者を `staff.enabled` だけで絞っている挙動をそのまま保つ。組織の有効/無効を担当者へ
 * 波及させると、**いま到達できている担当者が到達できなくなる**（J-OR-01 / J-OR-02 の
 * 成功条件＝担当者へ到達できる、に直結する退行）。
 *
 * この規則は明文化しないと簡単に失われる。「組織が無効なら中の人も無効だろう」は直感的に
 * 正しく見えるので、**将来のリファクタで善意から入り込む**。テストで固定する。
 */
describe('getVisitorDirectory (#373 増分 4)', () => {
  it('保存済み組織が無い間は、現行の getKioskDirectory と同じ結果になる（順序込み）', async () => {
    // **複数件で並べる。** 1 件だと順序の食い違いを検出できない。来訪者の画面は
    // この配列順にそのまま並ぶので、順序が変わるのは見た目の変更そのもの。
    for (const name of ['総務部', '営業部', '技術部']) {
      const created = await createDepartment(T, { name });
      if (!created.ok) throw new Error('fixture failed');
    }
    const dept = await createDepartment(T, { name: '広報部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const derived = await getVisitorDirectory(SCOPE);
    const current = await getKioskDirectory(T);

    // 段階移行の前提: 新モデルへ何も保存していない状態では**見えるものが変わらない**。
    expect(derived.departments).toEqual(current.departments);
    expect(derived.staff).toEqual(current.staff);
  });

  /**
   * **規則 A の本体。** ここが落ちるということは、組織の無効化が担当者の呼び出し可否へ
   * 波及したということ。受付完遂に直結するので、意図的な仕様変更でない限り実装側を直す。
   */
  it('部署を無効化しても、その部署の担当者は呼べるまま残る', async () => {
    const dept = await createDepartment(T, { name: '総務部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '鈴木 花子', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    await updateDepartment(T, dept.value.id, { enabled: false });

    const directory = await getVisitorDirectory(SCOPE);

    // 組織一覧からは消える（来訪者は「総務部」を選べない）。
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
    // だが担当者は名前で呼べる。
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(true);
  });

  it('担当者自身を無効化したら呼べなくなる（絞り込みの根拠は staff.enabled だけ）', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '佐藤 次郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const { updateStaff } = await import('@/lib/data-stores/directory-store');
    await updateStaff(T, staff.value.id, { enabled: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.some((s) => s.id === staff.value.id)).toBe(false);
  });

  /**
   * 新 UI 側の編集（表示名・非公開）は来訪者向けの組織一覧に効く。ここが効かないと
   * 「新 UI で直したのに来訪者の画面が変わらない」＝消費者ゼロの契約になる。
   */
  it('保存済みの公開表示名が来訪者向けの組織名に反映される', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, { ...unit, publicDisplayName: '営業（お客さま窓口）' });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.find((d) => d.id === dept.value.id)?.name).toBe(
      '営業（お客さま窓口）',
    );
  });

  it('非公開にした組織は来訪者向けの一覧に出ない', async () => {
    const dept = await createDepartment(T, { name: '内部監査室' });
    if (!dept.ok) throw new Error('fixture failed');
    const unit = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (unit === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, { ...unit, publicInDirectory: false });

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.departments.some((d) => d.id === dept.value.id)).toBe(false);
  });

  it('別テナントの組織・担当者は混ざらない', async () => {
    await __resetDirectory('acme');
    await __resetOrganization('acme');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const other = await getVisitorDirectory({ kind: 'tenant', tenantId: 'acme' });
    expect(other.departments.some((d) => d.id === dept.value.id)).toBe(false);
  });
});
