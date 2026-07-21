import { describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import { MOCK_DEPARTMENTS, MOCK_STAFF } from '@/domain/staff/mock-data';
import type { Staff } from '@/domain/staff/types';
import {
  membershipFromStaff,
  mergeOrganizationUnits,
  organizationUnitFromDepartment,
  readOrganizationCompat,
} from './compat';
import { validateOrganizationHierarchy } from './hierarchy';
import type { OrganizationUnit } from './types';

const SCOPE = { kind: 'site', tenantId: 'tenant-a', siteId: 'site-1' } as const;

function staff(overrides: Partial<Staff> & Pick<Staff, 'id' | 'displayName'>): Staff {
  return {
    aliases: [],
    departmentId: 'dept-sales',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
    ...overrides,
  };
}

describe('organizationUnitFromDepartment', () => {
  const dept: Department = {
    id: 'dept-sales',
    name: '営業部',
    kana: 'えいぎょうぶ',
    displayOrder: 1,
    enabled: true,
  };

  it('部署 id をそのまま組織 id にする（既存参照を壊さない）', () => {
    expect(organizationUnitFromDepartment(dept, SCOPE).id).toBe('dept-sales');
  });

  it('移行時点では正式名称と公開表示名を同じにする（運用で分離していく）', () => {
    const unit = organizationUnitFromDepartment(dept, SCOPE);
    expect(unit.officialName).toBe('営業部');
    expect(unit.publicDisplayName).toBe('営業部');
  });

  it('フラットな部署はルート組織になる', () => {
    expect(organizationUnitFromDepartment(dept, SCOPE).parentId).toBeUndefined();
  });

  it('scope の tenant/site を引き継ぎ、enabled / displayOrder / kana を保つ', () => {
    const unit = organizationUnitFromDepartment(dept, SCOPE);
    expect(unit.tenantId).toBe('tenant-a');
    expect(unit.siteId).toBe('site-1');
    expect(unit.enabled).toBe(true);
    expect(unit.displayOrder).toBe(1);
    expect(unit.kana).toBe('えいぎょうぶ');
  });

  it('無効な部署は無効な組織として読める（勝手に有効化しない）', () => {
    expect(organizationUnitFromDepartment({ ...dept, enabled: false }, SCOPE).enabled).toBe(false);
  });

  it('冪等（同じ入力から同じ組織を返す）', () => {
    expect(organizationUnitFromDepartment(dept, SCOPE)).toEqual(
      organizationUnitFromDepartment(dept, SCOPE),
    );
  });
});

describe('membershipFromStaff', () => {
  it('現行 departmentId を主所属として読む', () => {
    const m = membershipFromStaff(staff({ id: 'staff-1', displayName: '佐藤' }));
    expect(m).toEqual({
      staffId: 'staff-1',
      organizationId: 'dept-sales',
      relation: 'primary',
      publicInDirectory: true,
      callable: true,
    });
  });

  it('departmentId が空なら所属なしとして扱う', () => {
    expect(membershipFromStaff(staff({ id: 'x', displayName: 'x', departmentId: '' }))).toBeUndefined();
  });

  it('無効な担当者は呼び出し不可・非公開として読む', () => {
    const m = membershipFromStaff(staff({ id: 'x', displayName: 'x', enabled: false }));
    expect(m?.callable).toBe(false);
    expect(m?.publicInDirectory).toBe(false);
  });

  it('fallbackStaffIds を代理担当（acting）へ昇格させない', () => {
    // 既存の fallbackStaffIds は呼び出し導線であって代理担当の設定ではない。
    // 意味を勝手に変えると #374 の RoutingPolicy と二重定義になる。
    const m = membershipFromStaff(
      staff({ id: 'x', displayName: 'x', fallbackStaffIds: ['staff-other'] }),
    );
    expect(m?.relation).toBe('primary');
  });
});

describe('readOrganizationCompat', () => {
  it('現行 Department / Staff を階層モデルとして読める', () => {
    const result = readOrganizationCompat(
      { departments: MOCK_DEPARTMENTS, staff: MOCK_STAFF },
      SCOPE,
    );
    expect(result.units).toHaveLength(MOCK_DEPARTMENTS.length);
    expect(result.memberships.length).toBeGreaterThan(0);
    expect(result.memberships.every((m) => m.relation === 'primary')).toBe(true);
  });

  it('読み出した階層は妥当（循環なし・深度 1）', () => {
    const { units } = readOrganizationCompat(
      { departments: MOCK_DEPARTMENTS, staff: MOCK_STAFF },
      SCOPE,
    );
    expect(validateOrganizationHierarchy(units)).toEqual([]);
    expect(units.every((u) => u.parentId === undefined)).toBe(true);
  });

  it('存在しない部署を指す担当者の所属は落とす（不整合を持ち込まない）', () => {
    const result = readOrganizationCompat(
      {
        departments: MOCK_DEPARTMENTS,
        staff: [staff({ id: 'ghost-staff', displayName: '幽霊', departmentId: 'dept-none' })],
      },
      SCOPE,
    );
    expect(result.memberships).toEqual([]);
    expect(result.unresolvedStaffIds).toEqual(['ghost-staff']);
  });

  it('入力の Department / Staff を変更しない（加算的で非破壊）', () => {
    const snapshot = JSON.stringify(MOCK_DEPARTMENTS);
    readOrganizationCompat({ departments: MOCK_DEPARTMENTS, staff: MOCK_STAFF }, SCOPE);
    expect(JSON.stringify(MOCK_DEPARTMENTS)).toBe(snapshot);
  });
});

describe('mergeOrganizationUnits', () => {
  const compat: OrganizationUnit[] = [
    organizationUnitFromDepartment(
      { id: 'dept-sales', name: '営業部', displayOrder: 1, enabled: true },
      SCOPE,
    ),
  ];

  it('保存済みの組織定義が compat 由来より優先される（段階移行）', () => {
    const stored: OrganizationUnit[] = [
      { ...compat[0]!, publicDisplayName: '営業', officialName: '第一営業本部' },
    ];
    const merged = mergeOrganizationUnits(compat, stored, SCOPE);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.publicDisplayName).toBe('営業');
    expect(merged[0]?.officialName).toBe('第一営業本部');
  });

  it('[#394-7] 部署側で無効化したら、保存済みが有効でも無効になる（fail-closed）', () => {
    const closedCompat = [
      organizationUnitFromDepartment(
        { id: 'dept-sales', name: '営業部', displayOrder: 1, enabled: false },
        SCOPE,
      ),
    ];
    const stored: OrganizationUnit[] = [{ ...compat[0]!, enabled: true }];
    expect(mergeOrganizationUnits(closedCompat, stored, SCOPE)[0]?.enabled).toBe(false);
  });

  it('[#394-7] 保存済み側で無効化した場合も無効になる', () => {
    const stored: OrganizationUnit[] = [{ ...compat[0]!, enabled: false }];
    expect(mergeOrganizationUnits(compat, stored, SCOPE)[0]?.enabled).toBe(false);
  });

  it('[#394-7] 両方有効なときだけ有効', () => {
    const stored: OrganizationUnit[] = [{ ...compat[0]!, publicDisplayName: '営業' }];
    expect(mergeOrganizationUnits(compat, stored, SCOPE)[0]?.enabled).toBe(true);
  });

  it('[#394-7] scope 境界外の保存済み組織は落とす', () => {
    const foreign: OrganizationUnit[] = [
      { ...compat[0]!, id: 'foreign', tenantId: 'tenant-b' },
      { ...compat[0]!, id: 'other-site', siteId: 'site-2' },
    ];
    const ids = mergeOrganizationUnits(compat, foreign, SCOPE).map((u) => u.id);
    expect(ids).toEqual(['dept-sales']);
  });

  it('保存済みにしか無い組織も残す（新設の階層組織）', () => {
    const stored: OrganizationUnit[] = [
      {
        id: 'org-new',
        tenantId: 'tenant-a',
        siteId: 'site-1',
        parentId: 'dept-sales',
        officialName: '第一営業本部 営業一課',
        publicDisplayName: '営業一課',
        aliases: [],
        displayOrder: 1,
        enabled: true,
        publicInDirectory: true,
      },
    ];
    const merged = mergeOrganizationUnits(compat, stored, SCOPE);
    expect(merged.map((u) => u.id).sort()).toEqual(['dept-sales', 'org-new']);
    expect(validateOrganizationHierarchy(merged)).toEqual([]);
  });
});
