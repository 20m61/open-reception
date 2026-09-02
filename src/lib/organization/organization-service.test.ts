import { beforeEach, describe, expect, it } from 'vitest';
import { getOrganizationView } from './organization-service';
import {
  __resetOrganization,
  putOrganizationMembership,
  putOrganizationUnit,
} from './organization-repository';
import {
  __resetDirectory,
  createDepartment,
  createStaff,
} from '@/lib/data-stores/directory-store';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

/**
 * 既存の部署・担当者（互換）と保存済みの組織・所属を**合成して 1 つのビュー**にする
 * (#373 増分 3)。移行期に「旧 UI で閉じたのに来訪者から呼べる」食い違いを作らないことが要点。
 *
 * `unresolvedStaffIds` はここでは検査しない — **API 経由では作れない状態**だから。
 * `updateStaff` が `departmentId` を既存部署に対して検証するので、宙に浮いた参照は通常経路では
 * 生まれない（移行・直接書き込みに対する防御として domain 側が扱う）。判定そのものは
 * `domain/organization/compat.test.ts` が固定している。ここで無理に作ると
 * **実際には起きない状態を検査する**ことになる。
 */
describe('getOrganizationView (#373 増分 3)', () => {
  it('保存済み組織が無くても、既存の部署から組織ビューを作れる', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const view = await getOrganizationView(SCOPE);

    expect(view.units.some((u) => u.id === dept.value.id)).toBe(true);
  });

  it('保存済み組織の編集結果（表示名）が互換より優先される', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const compat = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (compat === undefined) throw new Error('fixture failed');

    await putOrganizationUnit(T, { ...compat, publicDisplayName: '営業（新）' });

    const view = await getOrganizationView(SCOPE);
    expect(view.units.find((u) => u.id === dept.value.id)?.publicDisplayName).toBe('営業（新）');
  });

  /**
   * **閉じる方向は必ず効く。** ここが崩れると、旧 UI で部署を閉じたのに新 UI 由来の定義が
   * 生き残り、来訪者から呼べる状態が段階移行期に残る。
   */
  it('旧 UI で部署を無効化したら、保存済みが有効でも無効になる', async () => {
    const dept = await createDepartment(T, { name: '総務部' });
    if (!dept.ok) throw new Error('fixture failed');
    const compat = (await getOrganizationView(SCOPE)).units.find((u) => u.id === dept.value.id);
    if (compat === undefined) throw new Error('fixture failed');
    await putOrganizationUnit(T, { ...compat, enabled: true });

    // 旧 UI 側で閉じる。
    const { updateDepartment } = await import('@/lib/data-stores/directory-store');
    await updateDepartment(T, dept.value.id, { enabled: false });

    const view = await getOrganizationView(SCOPE);
    expect(view.units.find((u) => u.id === dept.value.id)?.enabled).toBe(false);
  });

  it('担当者の所属も合成され、閉じる方向が効く', async () => {
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');
    const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: dept.value.id });
    if (!staff.ok) throw new Error('fixture failed');

    const before = await getOrganizationView(SCOPE);
    const membership = before.memberships.find((m) => m.staffId === staff.value.id);
    expect(membership?.callable).toBe(true);

    // 新 UI 側で呼び出し不可にする。
    if (membership === undefined) throw new Error('fixture failed');
    await putOrganizationMembership(T, { ...membership, callable: false });

    const after = await getOrganizationView(SCOPE);
    expect(after.memberships.find((m) => m.staffId === staff.value.id)?.callable).toBe(false);
  });

  it('別テナントの組織は見えない', async () => {
    await __resetOrganization('acme');
    const dept = await createDepartment(T, { name: '営業部' });
    if (!dept.ok) throw new Error('fixture failed');

    const other = await getOrganizationView({ kind: 'tenant', tenantId: 'acme' });
    expect(other.units.some((u) => u.id === dept.value.id)).toBe(false);
  });
});
