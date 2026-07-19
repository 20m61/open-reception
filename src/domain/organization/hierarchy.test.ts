import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_DEPTH,
  ancestorsOf,
  buildOrganizationTree,
  canSetParent,
  depthOf,
  descendantIdsOf,
  findOrganizationCycle,
  validateOrganizationHierarchy,
} from './hierarchy';
import type { OrganizationUnit } from './types';

function unit(
  overrides: Partial<OrganizationUnit> & Pick<OrganizationUnit, 'id'>,
): OrganizationUnit {
  return {
    tenantId: 'tenant-a',
    officialName: `正式:${overrides.id}`,
    publicDisplayName: `公開:${overrides.id}`,
    aliases: [],
    displayOrder: 0,
    enabled: true,
    publicInDirectory: true,
    ...overrides,
  };
}

/** 会社 > 本部 > 部 > 課 の 4 階層。 */
const CHAIN: OrganizationUnit[] = [
  unit({ id: 'org-company' }),
  unit({ id: 'org-hq', parentId: 'org-company' }),
  unit({ id: 'org-dept', parentId: 'org-hq' }),
  unit({ id: 'org-team', parentId: 'org-dept' }),
];

describe('validateOrganizationHierarchy', () => {
  it('正常な階層では問題を返さない', () => {
    expect(validateOrganizationHierarchy(CHAIN)).toEqual([]);
  });

  it('循環する組織階層を拒否する', () => {
    const cyclic = [
      unit({ id: 'a', parentId: 'c' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'b' }),
    ];
    const issues = validateOrganizationHierarchy(cyclic);
    expect(issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('自分自身を親にする自己ループを拒否する', () => {
    const issues = validateOrganizationHierarchy([unit({ id: 'a', parentId: 'a' })]);
    expect(issues.some((i) => i.kind === 'cycle' && i.organizationId === 'a')).toBe(true);
  });

  it('存在しない親を参照する組織を拒否する', () => {
    const issues = validateOrganizationHierarchy([unit({ id: 'a', parentId: 'ghost' })]);
    expect(issues).toContainEqual({ kind: 'missing_parent', organizationId: 'a', parentId: 'ghost' });
  });

  it('別テナントの組織を親にできない（tenant 境界）', () => {
    const units = [
      unit({ id: 'other', tenantId: 'tenant-b' }),
      unit({ id: 'a', tenantId: 'tenant-a', parentId: 'other' }),
    ];
    const issues = validateOrganizationHierarchy(units);
    expect(issues.some((i) => i.kind === 'cross_tenant_parent' && i.organizationId === 'a')).toBe(
      true,
    );
  });

  it('別サイトの組織を親にできない（site 境界。親がテナント横断なら許す）', () => {
    const crossSite = [
      unit({ id: 'p', siteId: 'site-1' }),
      unit({ id: 'c', siteId: 'site-2', parentId: 'p' }),
    ];
    expect(validateOrganizationHierarchy(crossSite).some((i) => i.kind === 'cross_site_parent')).toBe(
      true,
    );

    const tenantWide = [unit({ id: 'p' }), unit({ id: 'c', siteId: 'site-2', parentId: 'p' })];
    expect(validateOrganizationHierarchy(tenantWide)).toEqual([]);
  });

  it('最大深度を超える階層を拒否する', () => {
    const deep: OrganizationUnit[] = [];
    for (let i = 0; i <= MAX_ORGANIZATION_DEPTH; i += 1) {
      deep.push(unit({ id: `n${i}`, parentId: i === 0 ? undefined : `n${i - 1}` }));
    }
    const issues = validateOrganizationHierarchy(deep);
    expect(issues.some((i) => i.kind === 'max_depth_exceeded')).toBe(true);
  });

  it('id が重複する組織を拒否する', () => {
    const issues = validateOrganizationHierarchy([unit({ id: 'a' }), unit({ id: 'a' })]);
    expect(issues).toContainEqual({ kind: 'duplicate_id', organizationId: 'a' });
  });
});

describe('findOrganizationCycle', () => {
  it('循環に含まれる組織 id を返す', () => {
    const cyclic = [unit({ id: 'a', parentId: 'b' }), unit({ id: 'b', parentId: 'a' })];
    expect(findOrganizationCycle(cyclic)?.sort()).toEqual(['a', 'b']);
  });

  it('循環が無ければ null を返す', () => {
    expect(findOrganizationCycle(CHAIN)).toBeNull();
  });
});

describe('depthOf / ancestorsOf / descendantIdsOf', () => {
  it('ルートの深さは 1', () => {
    expect(depthOf(CHAIN, 'org-company')).toBe(1);
  });

  it('子孫の深さを数えられる', () => {
    expect(depthOf(CHAIN, 'org-team')).toBe(4);
  });

  it('祖先をルートに近い順で返す（表示のパンくず用途）', () => {
    expect(ancestorsOf(CHAIN, 'org-team').map((u) => u.id)).toEqual([
      'org-company',
      'org-hq',
      'org-dept',
    ]);
  });

  it('循環していても祖先探索が無限ループしない', () => {
    const cyclic = [unit({ id: 'a', parentId: 'b' }), unit({ id: 'b', parentId: 'a' })];
    expect(ancestorsOf(cyclic, 'a').length).toBeLessThanOrEqual(2);
  });

  it('子孫 id を集められる', () => {
    expect(descendantIdsOf(CHAIN, 'org-hq').sort()).toEqual(['org-dept', 'org-team']);
  });
});

describe('canSetParent', () => {
  it('循環を作る親の付け替えを拒否する', () => {
    expect(canSetParent(CHAIN, 'org-company', 'org-team').ok).toBe(false);
  });

  it('自分自身を親にする付け替えを拒否する', () => {
    expect(canSetParent(CHAIN, 'org-hq', 'org-hq').ok).toBe(false);
  });

  it('最大深度を超える付け替えを拒否する', () => {
    // org-team は深さ 4。その下（深さ 5 = 上限）までは差し込める。
    const flat = [...CHAIN, unit({ id: 'org-solo' })];
    expect(canSetParent(flat, 'org-solo', 'org-team').ok).toBe(true);

    // 深さ 5 の組織の下へ差し込むと 6 になり上限を超える。
    const deeper = [...CHAIN, unit({ id: 'x', parentId: 'org-team' }), unit({ id: 'org-solo' })];
    const result = canSetParent(deeper, 'org-solo', 'x');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.kind === 'max_depth_exceeded')).toBe(
      true,
    );
  });

  it('部分木ごと動かすと深度超過になる付け替えを拒否する', () => {
    // org-hq(高さ3) を org-dept(深さ3) の下へ動かすと 3+3=6 で上限超過。
    const result = canSetParent(CHAIN, 'org-hq', 'org-dept');
    expect(result.ok).toBe(false);
  });

  it('ルート化（親なし）は常に許可する', () => {
    expect(canSetParent(CHAIN, 'org-team', undefined).ok).toBe(true);
  });

  it('別テナントの親を拒否する', () => {
    const units = [...CHAIN, unit({ id: 'foreign', tenantId: 'tenant-b' })];
    expect(canSetParent(units, 'org-team', 'foreign').ok).toBe(false);
  });
});

describe('buildOrganizationTree', () => {
  it('親子構造を displayOrder 順に組み立てる', () => {
    const units = [
      unit({ id: 'root' }),
      unit({ id: 'b', parentId: 'root', displayOrder: 2 }),
      unit({ id: 'a', parentId: 'root', displayOrder: 1 }),
    ];
    const tree = buildOrganizationTree(units);
    expect(tree.map((n) => n.unit.id)).toEqual(['root']);
    expect(tree[0]?.children.map((n) => n.unit.id)).toEqual(['a', 'b']);
  });

  it('親が範囲外の組織はルートとして扱う（孤児を落とさない）', () => {
    const tree = buildOrganizationTree([unit({ id: 'orphan', parentId: 'ghost' })]);
    expect(tree.map((n) => n.unit.id)).toEqual(['orphan']);
  });

  it('循環している組織はツリーに含めず落とさない（root 昇格）', () => {
    const cyclic = [unit({ id: 'a', parentId: 'b' }), unit({ id: 'b', parentId: 'a' })];
    const ids = buildOrganizationTree(cyclic).map((n) => n.unit.id);
    expect(ids.length).toBeGreaterThan(0);
  });
});
