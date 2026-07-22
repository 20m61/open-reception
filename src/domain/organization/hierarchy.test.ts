import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_DEPTH,
  ancestorsOf,
  buildOrganizationTree,
  canSetParent,
  depthOf,
  descendantIdsOf,
  findAllOrganizationCycleIds,
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

  it('[regression #394-4] 循環が複数あっても全件を issue として報告する', () => {
    const twoCycles = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'd' }),
      unit({ id: 'd', parentId: 'c' }),
    ];
    const cycleIds = validateOrganizationHierarchy(twoCycles)
      .filter((i) => i.kind === 'cycle')
      .map((i) => i.organizationId);
    expect(cycleIds.sort()).toEqual(['a', 'b', 'c', 'd']);
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

  it('循環していても祖先探索が無限ループせず、既訪問で打ち切る', () => {
    const cyclic = [unit({ id: 'a', parentId: 'b' }), unit({ id: 'b', parentId: 'a' })];
    // a -> b と辿り、b の親 a は訪問済みなので打ち切る。
    expect(ancestorsOf(cyclic, 'a').map((u) => u.id)).toEqual(['b']);
    expect(ancestorsOf(cyclic, 'b').map((u) => u.id)).toEqual(['a']);
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

  it('[#396] 対象と無関係な既存循環は付け替えをブロックしない', () => {
    const withUnrelatedCycle = [
      ...CHAIN,
      unit({ id: 'x', parentId: 'y' }),
      unit({ id: 'y', parentId: 'x' }),
      unit({ id: 'mover' }),
    ];
    // mover を org-company の下へ動かすのは健全。無関係な x<->y 循環では拒否しない。
    expect(canSetParent(withUnrelatedCycle, 'mover', 'org-company')).toEqual({ ok: true });
  });

  it('[#396] 対象自身が循環へ巻き込まれる付け替えは従来どおり拒否する', () => {
    // org-company を org-team の下へ動かすと company が循環に入る。
    const result = canSetParent(CHAIN, 'org-company', 'org-team');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.kind === 'cycle')).toBe(true);
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
    expect(buildOrganizationTree(cyclic).map((n) => n.unit.id).sort()).toEqual(['a', 'b']);
  });

  it('[regression #394-3] 循環が複数あっても 1 件も落とさない', () => {
    const twoCycles = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'd' }),
      unit({ id: 'd', parentId: 'c' }),
    ];
    const ids = buildOrganizationTree(twoCycles).map((n) => n.unit.id);
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('[regression #394-3] 正常な木と循環が混在しても全件出力する', () => {
    const mixed = [
      ...CHAIN,
      unit({ id: 'x', parentId: 'y' }),
      unit({ id: 'y', parentId: 'x' }),
      unit({ id: 'self', parentId: 'self' }),
    ];
    const collect = (nodes: ReturnType<typeof buildOrganizationTree>): string[] =>
      nodes.flatMap((n) => [n.unit.id, ...collect(n.children)]);
    expect(collect(buildOrganizationTree(mixed)).sort()).toEqual(
      mixed.map((u) => u.id).sort(),
    );
  });

  it('[regression #394-3] 循環ノードが入れ子になって重複出力されない', () => {
    const twoCycles = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'd' }),
      unit({ id: 'd', parentId: 'c' }),
    ];
    const roots = buildOrganizationTree(twoCycles);
    expect(roots.every((n) => n.children.length === 0)).toBe(true);
  });

  it('[#396] 二重循環 [a↔b, c↔d] でクラッシュせず全ノードをフラットな root で返す', () => {
    // 旧「防御的な回収」ブロックは、昇格ノードを親の children から外さないため children
    // グラフに循環が残り、sort が無限再帰して Maximum call stack でクラッシュしていた。
    // ブロック削除後はこの入力でも例外を投げず、4 件すべてを子を持たない root として返す。
    const twoCycles = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'd' }),
      unit({ id: 'd', parentId: 'c' }),
    ];
    let roots: ReturnType<typeof buildOrganizationTree> = [];
    expect(() => {
      roots = buildOrganizationTree(twoCycles);
    }).not.toThrow();
    expect(roots.map((n) => n.unit.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(roots.every((n) => n.children.length === 0)).toBe(true);
  });
});

describe('findAllOrganizationCycleIds (#394 finding 3/4)', () => {
  it('複数の循環に含まれる全ノードを返す', () => {
    const twoCycles = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'c', parentId: 'd' }),
      unit({ id: 'd', parentId: 'c' }),
    ];
    expect([...findAllOrganizationCycleIds(twoCycles)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('循環にぶら下がるだけのノードは含めない', () => {
    const units = [
      unit({ id: 'a', parentId: 'b' }),
      unit({ id: 'b', parentId: 'a' }),
      unit({ id: 'leaf', parentId: 'a' }),
    ];
    expect([...findAllOrganizationCycleIds(units)].sort()).toEqual(['a', 'b']);
  });

  it('自己ループも循環として返す', () => {
    expect([...findAllOrganizationCycleIds([unit({ id: 'self', parentId: 'self' })])]).toEqual([
      'self',
    ]);
  });

  it('循環が無ければ空', () => {
    expect(findAllOrganizationCycleIds(CHAIN).size).toBe(0);
  });
});
