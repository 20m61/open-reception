import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetOrganization,
  deleteOrganizationMembership,
  getOrganizationUnit,
  listOrganizationMemberships,
  listOrganizationUnits,
  putOrganizationMembership,
  putOrganizationUnit,
} from './organization-repository';
import type { OrganizationMembership, OrganizationUnit } from '@/domain/organization/types';

const T = 'internal';
const OTHER = 'acme';

function unit(id: string, patch: Partial<OrganizationUnit> = {}): OrganizationUnit {
  return {
    id,
    tenantId: T,
    officialName: `${id} 部`,
    publicDisplayName: `${id}`,
    aliases: [],
    displayOrder: 0,
    enabled: true,
    publicInDirectory: true,
    ...patch,
  };
}

function membership(
  staffId: string,
  organizationId: string,
  patch: Partial<OrganizationMembership> = {},
): OrganizationMembership {
  return {
    staffId,
    organizationId,
    relation: 'primary',
    publicInDirectory: true,
    callable: true,
    ...patch,
  };
}

beforeEach(async () => {
  await __resetOrganization(T);
  await __resetOrganization(OTHER);
});

describe('organization-repository (#373 増分 2)', () => {
  it('組織を保存して読み戻せる', async () => {
    await putOrganizationUnit(T, unit('org-1'));

    expect((await getOrganizationUnit(T, 'org-1'))?.officialName).toBe('org-1 部');
    expect(await listOrganizationUnits(T)).toHaveLength(1);
  });

  it('同じ id の保存は置換になる（重複しない）', async () => {
    await putOrganizationUnit(T, unit('org-1'));
    await putOrganizationUnit(T, unit('org-1', { officialName: '改称後' }));

    const all = await listOrganizationUnits(T);
    expect(all).toHaveLength(1);
    expect(all[0]?.officialName).toBe('改称後');
  });

  it('所属を保存して読み戻せる（合成 id は外へ出さない）', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));

    const all = await listOrganizationMemberships(T);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ staffId: 'staff-1', organizationId: 'org-1' });
    // 永続化の都合で付けた合成 id がドメインへ漏れない。
    expect(all[0]).not.toHaveProperty('id');
  });

  it('同じ staff × 組織の所属は 1 件に保たれる', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));
    await putOrganizationMembership(T, membership('staff-1', 'org-1', { callable: false }));

    const all = await listOrganizationMemberships(T);
    expect(all).toHaveLength(1);
    expect(all[0]?.callable).toBe(false);
  });

  it('兼務（同じ staff が別組織）は別件として残る', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));
    await putOrganizationMembership(T, membership('staff-1', 'org-2', { relation: 'secondary' }));

    expect(await listOrganizationMemberships(T)).toHaveLength(2);
  });

  it('所属を削除できる', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));
    await deleteOrganizationMembership(T, 'staff-1', 'org-1');

    expect(await listOrganizationMemberships(T)).toEqual([]);
  });
});

/**
 * **最初からテナント別に持つ** (#419 の教訓)。
 *
 * 既存ストアは単一テナントで作られ、fail-closed により 2 つ目以降のテナントが機能を
 * 使えない状態が長く残った。新しいストアで同じ轍を踏まない。
 */
describe('organization-repository のテナント分離 (#419 の教訓)', () => {
  it('別テナントには組織が見えない', async () => {
    await putOrganizationUnit(T, unit('org-1'));

    expect(await listOrganizationUnits(T)).toHaveLength(1);
    expect(await listOrganizationUnits(OTHER)).toEqual([]);
  });

  it('別テナントには所属が見えない', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));

    expect(await listOrganizationMemberships(T)).toHaveLength(1);
    expect(await listOrganizationMemberships(OTHER)).toEqual([]);
  });

  it('あるテナントの削除が他テナントへ波及しない', async () => {
    await putOrganizationMembership(T, membership('staff-1', 'org-1'));
    await putOrganizationMembership(OTHER, membership('staff-1', 'org-1'));

    await deleteOrganizationMembership(OTHER, 'staff-1', 'org-1');

    expect(await listOrganizationMemberships(T)).toHaveLength(1);
    expect(await listOrganizationMemberships(OTHER)).toEqual([]);
  });
});
