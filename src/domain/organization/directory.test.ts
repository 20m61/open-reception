import { describe, expect, it } from 'vitest';
import {
  affiliationSummaryLabel,
  listCallableMembers,
  listVisitorOrganizations,
  resolveActingMembers,
  resolveStaffAffiliations,
  searchVisitorOrganizations,
  toVisitorOrganization,
} from './directory';
import type { OrganizationMembership, OrganizationUnit } from './types';
import { scopeOrganizationUnits } from './types';

function unit(
  overrides: Partial<OrganizationUnit> & Pick<OrganizationUnit, 'id'>,
): OrganizationUnit {
  return {
    tenantId: 'tenant-a',
    officialName: `株式会社サンプル ${overrides.id} 本部`,
    publicDisplayName: overrides.id,
    aliases: [],
    displayOrder: 0,
    enabled: true,
    publicInDirectory: true,
    ...overrides,
  };
}

function membership(
  overrides: Partial<OrganizationMembership> &
    Pick<OrganizationMembership, 'staffId' | 'organizationId' | 'relation'>,
): OrganizationMembership {
  return { publicInDirectory: true, callable: true, ...overrides };
}

const UNITS: OrganizationUnit[] = [
  unit({ id: 'sales', publicDisplayName: '営業部', kana: 'えいぎょうぶ', aliases: ['sales'] }),
  unit({ id: 'sales-1', parentId: 'sales', publicDisplayName: '営業一課', displayOrder: 1 }),
  unit({ id: 'dev', publicDisplayName: '開発部', kana: 'かいはつぶ', aliases: ['dev'] }),
  unit({ id: 'internal', publicDisplayName: '内部監査室', publicInDirectory: false }),
  unit({ id: 'closed', publicDisplayName: '旧総務部', enabled: false }),
];

describe('toVisitorOrganization', () => {
  it('来訪者向けには公開表示名だけを出し、内部正式名称を漏らさない', () => {
    const view = toVisitorOrganization(UNITS[0]!);
    expect(view.name).toBe('営業部');
    expect(JSON.stringify(view)).not.toContain('株式会社サンプル');
    expect('officialName' in view).toBe(false);
  });
});

describe('listVisitorOrganizations', () => {
  it('無効・非公開の組織を除外する', () => {
    const ids = listVisitorOrganizations(UNITS, { tenantId: 'tenant-a' }).map((o) => o.id);
    expect(ids).toEqual(['sales', 'sales-1', 'dev']);
  });

  it('他テナントの組織を参照できない', () => {
    const withForeign = [...UNITS, unit({ id: 'foreign', tenantId: 'tenant-b' })];
    const ids = listVisitorOrganizations(withForeign, { tenantId: 'tenant-a' }).map((o) => o.id);
    expect(ids).not.toContain('foreign');
  });

  it('site 指定時は他サイト専用の組織を除外し、テナント横断組織は残す', () => {
    const withSites = [
      unit({ id: 'site1-only', siteId: 'site-1' }),
      unit({ id: 'site2-only', siteId: 'site-2' }),
      unit({ id: 'tenant-wide' }),
    ];
    const ids = listVisitorOrganizations(withSites, {
      tenantId: 'tenant-a',
      siteId: 'site-1',
    }).map((o) => o.id);
    expect(ids).toEqual(['site1-only', 'tenant-wide']);
  });
});

describe('searchVisitorOrganizations', () => {
  it('公開表示名で検索できる', () => {
    const hits = searchVisitorOrganizations(UNITS, '営業', { tenantId: 'tenant-a' });
    expect(hits.map((o) => o.id)).toContain('sales');
  });

  it('よみ・別名でも検索できる', () => {
    expect(
      searchVisitorOrganizations(UNITS, 'かいはつ', { tenantId: 'tenant-a' }).map((o) => o.id),
    ).toContain('dev');
    expect(
      searchVisitorOrganizations(UNITS, 'sales', { tenantId: 'tenant-a' }).map((o) => o.id),
    ).toContain('sales');
  });

  it('内部正式名称では検索にヒットしない（内部名称を推測させない）', () => {
    expect(searchVisitorOrganizations(UNITS, '株式会社サンプル', { tenantId: 'tenant-a' })).toEqual(
      [],
    );
  });

  it('非公開・無効の組織は検索されない', () => {
    expect(searchVisitorOrganizations(UNITS, '内部監査', { tenantId: 'tenant-a' })).toEqual([]);
    expect(searchVisitorOrganizations(UNITS, '旧総務', { tenantId: 'tenant-a' })).toEqual([]);
  });
});

describe('resolveStaffAffiliations', () => {
  const memberships: OrganizationMembership[] = [
    membership({ staffId: 'staff-1', organizationId: 'sales', relation: 'primary' }),
    membership({ staffId: 'staff-1', organizationId: 'dev', relation: 'secondary' }),
    membership({ staffId: 'staff-1', organizationId: 'sales-1', relation: 'secondary' }),
    membership({ staffId: 'staff-2', organizationId: 'dev', relation: 'primary' }),
  ];

  it('主所属と複数の兼務を返す', () => {
    const result = resolveStaffAffiliations(memberships, UNITS, 'staff-1');
    expect(result.primary?.unit.id).toBe('sales');
    expect(result.secondary.map((a) => a.unit.id)).toEqual(['dev', 'sales-1']);
  });

  it('主所属が無くても兼務だけを返せる', () => {
    const only = [membership({ staffId: 'x', organizationId: 'dev', relation: 'secondary' })];
    const result = resolveStaffAffiliations(only, UNITS, 'x');
    expect(result.primary).toBeUndefined();
    expect(result.secondary).toHaveLength(1);
  });

  it('scope 外の組織の所属は返さない（tenant 境界）', () => {
    const foreignUnits = [...UNITS, unit({ id: 'foreign', tenantId: 'tenant-b' })];
    const withForeign = [
      ...memberships,
      membership({ staffId: 'staff-1', organizationId: 'foreign', relation: 'secondary' }),
    ];
    const result = resolveStaffAffiliations(withForeign, foreignUnits, 'staff-1', {
      tenantId: 'tenant-a',
    });
    expect(result.secondary.map((a) => a.unit.id)).not.toContain('foreign');
  });

  it('非公開の所属は来訪者向け一覧から除外できる', () => {
    const hidden = [
      membership({
        staffId: 'staff-3',
        organizationId: 'sales',
        relation: 'primary',
        publicInDirectory: false,
      }),
    ];
    expect(resolveStaffAffiliations(hidden, UNITS, 'staff-3').primary).toBeDefined();
    expect(
      resolveStaffAffiliations(hidden, UNITS, 'staff-3', undefined, { visitorFacing: true }).primary,
    ).toBeUndefined();
  });

  it('祖先組織を所属として自動的に足さない（親子＝取次フォールバックではない）', () => {
    const child = [membership({ staffId: 'y', organizationId: 'sales-1', relation: 'primary' })];
    const result = resolveStaffAffiliations(child, UNITS, 'y');
    expect(result.primary?.unit.id).toBe('sales-1');
    expect(result.secondary).toEqual([]);
    // 表示用のパンくずとしてのみ祖先を持つ。
    expect(result.primary?.ancestors.map((u) => u.id)).toEqual(['sales']);
  });
});

describe('affiliationSummaryLabel (#373 同姓同名の識別)', () => {
  it('主所属と兼務を併記して同姓同名を区別できる', () => {
    const memberships = [
      membership({ staffId: 's', organizationId: 'sales', relation: 'primary' }),
      membership({ staffId: 's', organizationId: 'dev', relation: 'secondary' }),
    ];
    const label = affiliationSummaryLabel(resolveStaffAffiliations(memberships, UNITS, 's'));
    expect(label).toBe('営業部（兼: 開発部）');
  });

  it('主所属のみなら兼務の括弧を出さない', () => {
    const memberships = [membership({ staffId: 's', organizationId: 'sales', relation: 'primary' })];
    expect(affiliationSummaryLabel(resolveStaffAffiliations(memberships, UNITS, 's'))).toBe('営業部');
  });

  it('所属が無ければ空文字を返す', () => {
    expect(affiliationSummaryLabel(resolveStaffAffiliations([], UNITS, 's'))).toBe('');
  });

  it('親組織があるときはパンくずで区別できる', () => {
    const memberships = [
      membership({ staffId: 's', organizationId: 'sales-1', relation: 'primary' }),
    ];
    const label = affiliationSummaryLabel(resolveStaffAffiliations(memberships, UNITS, 's'), {
      includeAncestors: true,
    });
    expect(label).toBe('営業部 / 営業一課');
  });
});

describe('listCallableMembers (#373 親子で自動 fallback しない)', () => {
  const memberships: OrganizationMembership[] = [
    membership({ staffId: 'parent-staff', organizationId: 'sales', relation: 'primary' }),
    membership({ staffId: 'child-staff', organizationId: 'sales-1', relation: 'primary' }),
    membership({
      staffId: 'uncallable',
      organizationId: 'sales-1',
      relation: 'secondary',
      callable: false,
    }),
  ];

  it('指定した組織の所属だけを返し、親組織へ遡らない', () => {
    const ids = listCallableMembers(memberships, UNITS, 'sales-1').map((m) => m.staffId);
    expect(ids).toEqual(['child-staff']);
    expect(ids).not.toContain('parent-staff');
  });

  it('子組織へも降りない（fallback は #374 の RoutingPolicy で明示する）', () => {
    const ids = listCallableMembers(memberships, UNITS, 'sales').map((m) => m.staffId);
    expect(ids).toEqual(['parent-staff']);
  });

  it('無効な組織では呼び出し候補を返さない', () => {
    expect(listCallableMembers(memberships, UNITS, 'closed')).toEqual([]);
  });

  it('主所属を兼務より先に並べる', () => {
    const mixed = [
      membership({ staffId: 'b', organizationId: 'dev', relation: 'secondary' }),
      membership({ staffId: 'a', organizationId: 'dev', relation: 'primary' }),
    ];
    expect(listCallableMembers(mixed, UNITS, 'dev').map((m) => m.staffId)).toEqual(['a', 'b']);
  });
});

describe('resolveActingMembers (#373 代理担当)', () => {
  const now = '2026-07-19T00:00:00.000Z';

  it('代理担当を明示的に設定でき、代理元 staff で引ける', () => {
    const memberships = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
      }),
    ];
    const acting = resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now });
    expect(acting.map((a) => a.staffId)).toEqual(['deputy']);
  });

  it('有効期間外の代理担当は返さない', () => {
    const memberships = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
        validUntil: '2026-07-01T00:00:00.000Z',
      }),
    ];
    expect(resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now })).toEqual([]);
  });

  it('開始前の代理担当は返さない', () => {
    const memberships = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
        validFrom: '2026-08-01T00:00:00.000Z',
      }),
    ];
    expect(resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now })).toEqual([]);
  });

  it('組織単位でも代理担当を引ける', () => {
    const memberships = [
      membership({ staffId: 'deputy', organizationId: 'sales', relation: 'acting' }),
      membership({ staffId: 'other', organizationId: 'dev', relation: 'acting' }),
    ];
    expect(
      resolveActingMembers(memberships, UNITS, { organizationId: 'sales', now }).map(
        (a) => a.staffId,
      ),
    ).toEqual(['deputy']);
  });

  it('acting 以外の関係は代理担当として扱わない', () => {
    const memberships = [membership({ staffId: 'x', organizationId: 'sales', relation: 'primary' })];
    expect(resolveActingMembers(memberships, UNITS, { organizationId: 'sales', now })).toEqual([]);
  });
});

describe('scopeOrganizationUnits', () => {
  it('テナント境界を跨ぐ組織を落とす', () => {
    const units = [unit({ id: 'a' }), unit({ id: 'b', tenantId: 'tenant-b' })];
    expect(scopeOrganizationUnits(units, { tenantId: 'tenant-a' }).map((u) => u.id)).toEqual(['a']);
  });
});
