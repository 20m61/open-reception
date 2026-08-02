import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSecondaryMembership,
  removeSecondaryMembership,
  getVisitorDirectory,
  getOrganizationView,
} from './organization-service';
import { __resetOrganization } from './organization-repository';
import { __resetDirectory, createDepartment, createStaff } from '@/lib/data-stores/directory-store';
import type { OrganizationScope } from '@/domain/organization/types';

const T = 'internal';
const SCOPE: OrganizationScope = { kind: 'tenant', tenantId: T };

beforeEach(async () => {
  await __resetDirectory(T);
  await __resetOrganization(T);
});

async function fixture() {
  const main = await createDepartment(T, { name: '営業部' });
  const also = await createDepartment(T, { name: '技術部' });
  if (!main.ok || !also.ok) throw new Error('fixture failed');
  const staff = await createStaff(T, { displayName: '山田 太郎', departmentId: main.value.id });
  if (!staff.ok) throw new Error('fixture failed');
  return { mainId: main.value.id, alsoId: also.value.id, staffId: staff.value.id };
}

/**
 * 兼務の設定 (#373 増分 8)。
 *
 * ## なぜこれが要るか
 *
 * 同姓同名の識別ラベル（#590）は兼務を「営業部（兼: 技術部）」と表示するが、
 * **兼務を作る経路が本番に 1 つも無かった**（`putOrganizationMembership` の呼び出し元が
 * テストだけ）。表示側だけ在って生産者が無い契約は腐る。
 *
 * 主所属は `staff.departmentId` が持つのでここでは触らない。触れると真実源が二重になる。
 * 代理担当は来訪者面に出さない決定（(A)）なので消費者が無く、この増分では扱わない。
 */
describe('兼務の設定 (#373 増分 8)', () => {
  it('兼務を追加すると来訪者のラベルに出る', async () => {
    const { alsoId, staffId } = await fixture();

    const result = await addSecondaryMembership(SCOPE, staffId, alsoId);
    expect(result.ok).toBe(true);

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.find((s) => s.id === staffId)?.affiliation).toEqual({
      primary: '営業部',
      secondary: ['技術部'],
    });
  });

  it('兼務を外すとラベルから消える', async () => {
    const { alsoId, staffId } = await fixture();
    await addSecondaryMembership(SCOPE, staffId, alsoId);

    const result = await removeSecondaryMembership(SCOPE, staffId, alsoId);
    expect(result.ok).toBe(true);

    const directory = await getVisitorDirectory(SCOPE);
    expect(directory.staff.find((s) => s.id === staffId)?.affiliation?.secondary).toEqual([]);
  });

  /** 主所属は `staff.departmentId` が真実源。兼務として二重に持たせない。 */
  it('主所属と同じ組織は兼務にできない', async () => {
    const { mainId, staffId } = await fixture();
    const result = await addSecondaryMembership(SCOPE, staffId, mainId);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('invalid_input');
  });

  it('存在しない担当者・組織は not_found', async () => {
    const { alsoId, staffId } = await fixture();
    expect((await addSecondaryMembership(SCOPE, 'nope', alsoId)).ok).toBe(false);
    expect((await addSecondaryMembership(SCOPE, staffId, 'nope')).ok).toBe(false);
  });

  /** 「在るが見えない」と「無い」を区別させない（他テナントの id の実在を当てさせない）。 */
  it('別テナントの組織は兼務にできない', async () => {
    await __resetDirectory('acme');
    await __resetOrganization('acme');
    const { staffId } = await fixture();
    const other = await createDepartment('acme', { name: '他社技術部' });
    if (!other.ok) throw new Error('fixture failed');

    const result = await addSecondaryMembership(SCOPE, staffId, other.value.id);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('not_found');
  });

  it('同じ兼務を二重に追加しても 1 件のまま', async () => {
    const { alsoId, staffId } = await fixture();
    await addSecondaryMembership(SCOPE, staffId, alsoId);
    await addSecondaryMembership(SCOPE, staffId, alsoId);

    const view = await getOrganizationView(SCOPE);
    const count = view.memberships.filter(
      (m) => m.staffId === staffId && m.organizationId === alsoId,
    ).length;
    expect(count).toBe(1);
  });
});
