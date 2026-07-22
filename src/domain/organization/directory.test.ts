import { describe, expect, it } from 'vitest';
import {
  affiliationSummaryLabel,
  isActiveAt,
  listCallableMembers,
  listVisitorOrganizations,
  resolveActingMembers,
  resolveStaffAffiliations,
  searchVisitorOrganizations,
  toVisitorAffiliations,
  toVisitorOrganization,
  validateOrganizationMembership,
} from './directory';
import type { OrganizationMembership, OrganizationUnit } from './types';
import { scopeOrganizationUnits } from './types';

const NOW = '2026-07-19T00:00:00.000Z';
const TENANT = { kind: 'tenant', tenantId: 'tenant-a' } as const;

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

/** 非公開の親を持つ公開の子（PR #394 レビュー finding 1/5 の再現形）。 */
const HIDDEN_PARENT: OrganizationUnit[] = [
  unit({ id: 'internal', publicDisplayName: '内部監査室', publicInDirectory: false }),
  unit({ id: 'child', parentId: 'internal', publicDisplayName: '調査一課' }),
];

describe('toVisitorOrganization', () => {
  it('来訪者向けには公開表示名だけを出し、内部正式名称を漏らさない', () => {
    const view = toVisitorOrganization(UNITS[0]!, new Set(['sales']));
    expect(view.name).toBe('営業部');
    expect(JSON.stringify(view)).not.toContain('株式会社サンプル');
    expect('officialName' in view).toBe(false);
  });

  it('公開集合に居ない親の id は落とす', () => {
    expect(toVisitorOrganization(HIDDEN_PARENT[1]!, new Set(['child'])).parentId).toBeUndefined();
  });
});

describe('listVisitorOrganizations', () => {
  it('無効・非公開の組織を除外する', () => {
    expect(listVisitorOrganizations(UNITS, TENANT).map((o) => o.id)).toEqual([
      'sales',
      'sales-1',
      'dev',
    ]);
  });

  it('他テナントの組織を参照できない', () => {
    const withForeign = [...UNITS, unit({ id: 'foreign', tenantId: 'tenant-b' })];
    expect(listVisitorOrganizations(withForeign, TENANT).map((o) => o.id)).not.toContain('foreign');
  });

  it('site 指定時は他サイト専用の組織を除外し、テナント横断組織は残す', () => {
    const withSites = [
      unit({ id: 'site1-only', siteId: 'site-1' }),
      unit({ id: 'site2-only', siteId: 'site-2' }),
      unit({ id: 'tenant-wide' }),
    ];
    const ids = listVisitorOrganizations(withSites, {
      kind: 'site',
      tenantId: 'tenant-a',
      siteId: 'site-1',
    }).map((o) => o.id);
    expect(ids).toEqual(['site1-only', 'tenant-wide']);
  });

  it('[regression #394-5] 非公開の親 id を parentId として露出しない', () => {
    expect(listVisitorOrganizations(HIDDEN_PARENT, TENANT)).toEqual([
      { id: 'child', name: '調査一課', parentId: undefined },
    ]);
  });

  it('公開の親は parentId として残す', () => {
    expect(listVisitorOrganizations(UNITS, TENANT).find((o) => o.id === 'sales-1')?.parentId).toBe(
      'sales',
    );
  });
});

describe('searchVisitorOrganizations', () => {
  it('公開表示名で検索できる', () => {
    expect(searchVisitorOrganizations(UNITS, '営業', TENANT).map((o) => o.id)).toContain('sales');
  });

  it('よみ・別名でも検索できる', () => {
    expect(searchVisitorOrganizations(UNITS, 'かいはつ', TENANT).map((o) => o.id)).toContain('dev');
    expect(searchVisitorOrganizations(UNITS, 'sales', TENANT).map((o) => o.id)).toContain('sales');
  });

  it('内部正式名称では検索にヒットしない（内部名称を推測させない）', () => {
    expect(searchVisitorOrganizations(UNITS, '株式会社サンプル', TENANT)).toEqual([]);
  });

  it('非公開・無効の組織は検索されない', () => {
    expect(searchVisitorOrganizations(UNITS, '内部監査', TENANT)).toEqual([]);
    expect(searchVisitorOrganizations(UNITS, '旧総務', TENANT)).toEqual([]);
  });

  it('[regression #394-5] 検索結果でも非公開の親 id を露出しない', () => {
    expect(searchVisitorOrganizations(HIDDEN_PARENT, '調査', TENANT)).toEqual([
      { id: 'child', name: '調査一課', parentId: undefined },
    ]);
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
    const result = resolveStaffAffiliations(memberships, UNITS, 'staff-1', { now: NOW, scope: TENANT });
    expect(result.primary?.unit.id).toBe('sales');
    expect(result.secondary.map((a) => a.unit.id)).toEqual(['dev', 'sales-1']);
  });

  it('主所属が無くても兼務だけを返せる', () => {
    const only = [membership({ staffId: 'x', organizationId: 'dev', relation: 'secondary' })];
    const result = resolveStaffAffiliations(only, UNITS, 'x', { now: NOW, scope: TENANT });
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
      now: NOW,
      scope: TENANT,
    });
    expect(result.secondary.map((a) => a.unit.id)).not.toContain('foreign');
  });

  it('[regression #394-2] 期限切れの代理担当を acting に含めない', () => {
    const expired = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
        validUntil: '2020-01-01T00:00:00.000Z',
      }),
    ];
    expect(resolveStaffAffiliations(expired, UNITS, 'deputy', { now: NOW, scope: TENANT }).acting).toEqual([]);
  });

  it('有効期間内の代理担当は acting に含める', () => {
    const active = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        validUntil: '2026-12-31T00:00:00.000Z',
      }),
    ];
    expect(resolveStaffAffiliations(active, UNITS, 'deputy', { now: NOW, scope: TENANT }).acting).toHaveLength(1);
  });

  it('祖先組織を所属として自動的に足さない（親子＝取次フォールバックではない）', () => {
    const child = [membership({ staffId: 'y', organizationId: 'sales-1', relation: 'primary' })];
    const result = resolveStaffAffiliations(child, UNITS, 'y', { now: NOW, scope: TENANT });
    expect(result.primary?.unit.id).toBe('sales-1');
    expect(result.secondary).toEqual([]);
    // 表示用のパンくずとしてのみ祖先を持つ。
    expect(result.primary?.ancestors.map((u) => u.id)).toEqual(['sales']);
  });
});

describe('toVisitorAffiliations (PR #394 finding 1)', () => {
  it('[regression] 非公開の祖先を来訪者向けから落とす', () => {
    const ms = [membership({ staffId: 's', organizationId: 'child', relation: 'primary' })];
    const internal = resolveStaffAffiliations(ms, HIDDEN_PARENT, 's', { now: NOW, scope: TENANT });
    // 内部向け（管理画面のパンくず）には祖先が見える。
    expect(internal.primary?.ancestors.map((a) => a.id)).toEqual(['internal']);

    const visitor = toVisitorAffiliations(internal);
    expect(visitor.primary?.ancestors).toEqual([]);
    expect(visitor.primary?.unit.parentId).toBeUndefined();
  });

  it('[regression] 来訪者向けの戻り値に officialName が構造的に含まれない', () => {
    const ms = [membership({ staffId: 's', organizationId: 'sales-1', relation: 'primary' })];
    const visitor = toVisitorAffiliations(
      resolveStaffAffiliations(ms, UNITS, 's', { now: NOW, scope: TENANT }),
    );
    expect(JSON.stringify(visitor)).not.toContain('株式会社サンプル');
    expect(JSON.stringify(visitor)).not.toContain('officialName');
  });

  it('非公開の所属は落とす', () => {
    const hidden = [
      membership({
        staffId: 'staff-3',
        organizationId: 'sales',
        relation: 'primary',
        publicInDirectory: false,
      }),
    ];
    const internal = resolveStaffAffiliations(hidden, UNITS, 'staff-3', { now: NOW, scope: TENANT });
    expect(internal.primary).toBeDefined();
    expect(toVisitorAffiliations(internal).primary).toBeUndefined();
  });

  it('無効・非公開の組織そのものも落とす', () => {
    const ms = [
      membership({ staffId: 's', organizationId: 'closed', relation: 'primary' }),
      membership({ staffId: 's', organizationId: 'internal', relation: 'secondary' }),
    ];
    const visitor = toVisitorAffiliations(resolveStaffAffiliations(ms, UNITS, 's', { now: NOW, scope: TENANT }));
    expect(visitor.primary).toBeUndefined();
    expect(visitor.secondary).toEqual([]);
  });

  it('公開の祖先はパンくずとして残す', () => {
    const ms = [membership({ staffId: 's', organizationId: 'sales-1', relation: 'primary' })];
    const visitor = toVisitorAffiliations(resolveStaffAffiliations(ms, UNITS, 's', { now: NOW, scope: TENANT }));
    expect(visitor.primary?.ancestors.map((a) => a.name)).toEqual(['営業部']);
  });
});

describe('affiliationSummaryLabel (#373 同姓同名の識別)', () => {
  function label(
    ms: OrganizationMembership[],
    units: OrganizationUnit[] = UNITS,
    opts: { includeAncestors?: boolean } = {},
  ): string {
    return affiliationSummaryLabel(
      toVisitorAffiliations(resolveStaffAffiliations(ms, units, 's', { now: NOW, scope: TENANT })),
      opts,
    );
  }

  it('主所属と兼務を併記して同姓同名を区別できる', () => {
    expect(
      label([
        membership({ staffId: 's', organizationId: 'sales', relation: 'primary' }),
        membership({ staffId: 's', organizationId: 'dev', relation: 'secondary' }),
      ]),
    ).toBe('営業部（兼: 開発部）');
  });

  it('主所属のみなら兼務の括弧を出さない', () => {
    expect(label([membership({ staffId: 's', organizationId: 'sales', relation: 'primary' })])).toBe(
      '営業部',
    );
  });

  it('所属が無ければ空文字を返す', () => {
    expect(label([])).toBe('');
  });

  it('親組織があるときはパンくずで区別できる', () => {
    expect(
      label([membership({ staffId: 's', organizationId: 'sales-1', relation: 'primary' })], UNITS, {
        includeAncestors: true,
      }),
    ).toBe('営業部 / 営業一課');
  });

  it('[regression #394-1] 非公開の親をラベルへ出さない', () => {
    expect(
      label(
        [membership({ staffId: 's', organizationId: 'child', relation: 'primary' })],
        HIDDEN_PARENT,
        { includeAncestors: true },
      ),
    ).toBe('調査一課');
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
    const ids = listCallableMembers(memberships, UNITS, 'sales-1', { now: NOW, scope: TENANT }).map(
      (m) => m.staffId,
    );
    expect(ids).toEqual(['child-staff']);
    expect(ids).not.toContain('parent-staff');
  });

  it('子組織へも降りない（fallback は #374 の RoutingPolicy で明示する）', () => {
    expect(
      listCallableMembers(memberships, UNITS, 'sales', { now: NOW, scope: TENANT }).map((m) => m.staffId),
    ).toEqual(['parent-staff']);
  });

  it('無効な組織では呼び出し候補を返さない', () => {
    expect(listCallableMembers(memberships, UNITS, 'closed', { now: NOW, scope: TENANT })).toEqual([]);
  });

  it('主所属を兼務より先に並べる', () => {
    const mixed = [
      membership({ staffId: 'b', organizationId: 'dev', relation: 'secondary' }),
      membership({ staffId: 'a', organizationId: 'dev', relation: 'primary' }),
    ];
    expect(listCallableMembers(mixed, UNITS, 'dev', { now: NOW, scope: TENANT }).map((m) => m.staffId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('[regression #394-2] 期限切れの代理担当を呼び出し候補に含めない', () => {
    const expired = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
        validUntil: '2020-01-01T00:00:00.000Z',
      }),
    ];
    expect(listCallableMembers(expired, UNITS, 'sales', { now: NOW, scope: TENANT })).toEqual([]);
  });

  it('[regression #394-2] 開始前の代理担当も呼び出し候補に含めない', () => {
    const future = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        validFrom: '2027-01-01T00:00:00.000Z',
      }),
    ];
    expect(listCallableMembers(future, UNITS, 'sales', { now: NOW, scope: TENANT })).toEqual([]);
  });

  it('有効期間内の代理担当は呼び出し候補に含める', () => {
    const active = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-12-31T00:00:00.000Z',
      }),
    ];
    expect(listCallableMembers(active, UNITS, 'sales', { now: NOW, scope: TENANT }).map((m) => m.staffId)).toEqual([
      'deputy',
    ]);
  });

  it('期間指定の無い primary / secondary は期間評価の影響を受けない', () => {
    expect(
      listCallableMembers(memberships, UNITS, 'sales', { now: 'not-a-date', scope: TENANT }).map(
        (m) => m.staffId,
      ),
    ).toEqual(['parent-staff']);
  });
});

describe('isActiveAt (PR #394 finding 8)', () => {
  const base = {
    staffId: 's',
    organizationId: 'o',
    relation: 'acting' as const,
    publicInDirectory: true,
    callable: true,
  };

  it('オフセット表記が混ざっても正しく比較する（辞書順比較ではない）', () => {
    // 2026-07-19T09:00:00+09:00 === 2026-07-19T00:00:00Z なので境界ちょうどで有効。
    expect(isActiveAt({ ...base, validUntil: '2026-07-19T09:00:00+09:00' }, NOW)).toBe(true);
    // 辞書順だと '2026-07-19T00:00:00.000Z' < '2026-07-19T08:00:00+09:00' となり誤って無効になる。
    expect(isActiveAt({ ...base, validFrom: '2026-07-19T08:00:00+09:00' }, NOW)).toBe(true);
  });

  it('解釈できない日時は inactive 扱いにする（fail-closed）', () => {
    expect(isActiveAt({ ...base, validUntil: 'never' }, NOW)).toBe(false);
    expect(isActiveAt({ ...base, validFrom: '' }, NOW)).toBe(false);
    expect(isActiveAt(base, 'not-a-date')).toBe(false);
  });

  it('期間指定が無ければ常に有効', () => {
    expect(isActiveAt(base, NOW)).toBe(true);
  });
});

describe('resolveActingMembers (#373 代理担当)', () => {
  it('代理担当を明示的に設定でき、代理元 staff で引ける', () => {
    const memberships = [
      membership({
        staffId: 'deputy',
        organizationId: 'sales',
        relation: 'acting',
        actingForStaffId: 'boss',
      }),
    ];
    expect(
      resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now: NOW }, TENANT).map(
        (a) => a.staffId,
      ),
    ).toEqual(['deputy']);
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
    expect(resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now: NOW }, TENANT)).toEqual(
      [],
    );
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
    expect(resolveActingMembers(memberships, UNITS, { actingForStaffId: 'boss', now: NOW }, TENANT)).toEqual(
      [],
    );
  });

  it('組織単位でも代理担当を引ける', () => {
    const memberships = [
      membership({ staffId: 'deputy', organizationId: 'sales', relation: 'acting' }),
      membership({ staffId: 'other', organizationId: 'dev', relation: 'acting' }),
    ];
    expect(
      resolveActingMembers(memberships, UNITS, { organizationId: 'sales', now: NOW }, TENANT).map(
        (a) => a.staffId,
      ),
    ).toEqual(['deputy']);
  });

  it('acting 以外の関係は代理担当として扱わない', () => {
    const memberships = [membership({ staffId: 'x', organizationId: 'sales', relation: 'primary' })];
    expect(resolveActingMembers(memberships, UNITS, { organizationId: 'sales', now: NOW }, TENANT)).toEqual(
      [],
    );
  });
});

describe('scopeOrganizationUnits', () => {
  it('テナント境界を跨ぐ組織を落とす', () => {
    const units = [unit({ id: 'a' }), unit({ id: 'b', tenantId: 'tenant-b' })];
    expect(scopeOrganizationUnits(units, TENANT).map((u) => u.id)).toEqual(['a']);
  });
});

describe('#396 tenant/site 境界の必須化（scope / publicIds）', () => {
  const OTHER_TENANT_UNITS: OrganizationUnit[] = [
    unit({ id: 'foreign', tenantId: 'tenant-b', publicDisplayName: '他社営業部' }),
  ];

  it('resolveStaffAffiliations は scope 外（他テナント）の所属を 0 件に落とす（値固定）', () => {
    const ms = [membership({ staffId: 's', organizationId: 'foreign', relation: 'secondary' })];
    const result = resolveStaffAffiliations(ms, OTHER_TENANT_UNITS, 's', {
      now: NOW,
      scope: TENANT,
    });
    expect(result).toEqual({ secondary: [], acting: [] });
  });

  it('listCallableMembers は scope 外（他テナント）の組織で 0 件を返す（値固定）', () => {
    const ms = [membership({ staffId: 's', organizationId: 'foreign', relation: 'primary' })];
    expect(
      listCallableMembers(ms, OTHER_TENANT_UNITS, 'foreign', { now: NOW, scope: TENANT }),
    ).toEqual([]);
  });

  it('resolveActingMembers は scope 外（他テナント）の代理担当を 0 件に落とす（値固定）', () => {
    const ms = [
      membership({
        staffId: 'deputy',
        organizationId: 'foreign',
        relation: 'acting',
        actingForStaffId: 'boss',
      }),
    ];
    expect(
      resolveActingMembers(ms, OTHER_TENANT_UNITS, { actingForStaffId: 'boss', now: NOW }, TENANT),
    ).toEqual([]);
  });

  it('toVisitorOrganization は publicIds に無い親 id を parentId へ漏らさない（値固定）', () => {
    expect(toVisitorOrganization(HIDDEN_PARENT[1]!, new Set(['child']))).toEqual({
      id: 'child',
      name: '調査一課',
      parentId: undefined,
    });
  });

  // 以下は型レベルの契約を固定する（`@ts-expect-error` が消えたら required 化が退行）。
  // 実行はしない（scope/publicIds 省略で境界解決がクラッシュするのは当然なので、型で弾く）。
  it('[type] 必須引数の省略はコンパイルエラーになる', () => {
    const typeContracts = [
      // @ts-expect-error scope は必須（省略で他テナント組織のラベルが漏れる）。
      () => resolveStaffAffiliations([], UNITS, 'x', { now: NOW }),
      // @ts-expect-error scope は必須（省略で他テナント staff が候補へ混ざる）。
      () => listCallableMembers([], UNITS, 'sales', { now: NOW }),
      // @ts-expect-error scope（第4引数）は必須（省略で他テナントの代理担当が混ざる）。
      () => resolveActingMembers([], UNITS, { now: NOW }),
      // @ts-expect-error publicIds は必須（省略で非公開の親 id が漏れる）。
      () => toVisitorOrganization(UNITS[0]!),
    ];
    expect(typeContracts).toHaveLength(4);
  });
});

describe('validateOrganizationMembership (#396 有効期間は acting 専用)', () => {
  it('acting 以外に validFrom が付いていたら弾く（値固定）', () => {
    const m = membership({
      staffId: 's',
      organizationId: 'sales',
      relation: 'primary',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(validateOrganizationMembership(m)).toEqual([
      { kind: 'validity_period_on_non_acting', staffId: 's', organizationId: 'sales', relation: 'primary' },
    ]);
  });

  it('acting 以外に validUntil が付いていたら弾く（secondary も同様・値固定）', () => {
    const m = membership({
      staffId: 's',
      organizationId: 'dev',
      relation: 'secondary',
      validUntil: '2026-12-31T00:00:00.000Z',
    });
    expect(validateOrganizationMembership(m)).toEqual([
      { kind: 'validity_period_on_non_acting', staffId: 's', organizationId: 'dev', relation: 'secondary' },
    ]);
  });

  it('acting に有効期間が付いているのは妥当（0 件）', () => {
    const m = membership({
      staffId: 'deputy',
      organizationId: 'sales',
      relation: 'acting',
      actingForStaffId: 'boss',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-12-31T00:00:00.000Z',
    });
    expect(validateOrganizationMembership(m)).toEqual([]);
  });

  it('期間指定の無い primary は妥当（0 件）', () => {
    const m = membership({ staffId: 's', organizationId: 'sales', relation: 'primary' });
    expect(validateOrganizationMembership(m)).toEqual([]);
  });
});
