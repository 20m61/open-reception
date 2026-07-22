/**
 * 組織階層の検証・走査 (issue #373)。
 *
 * すべて純関数。**循環する組織階層を拒否する**ことと、tenant/site 境界を跨ぐ親子を
 * 拒否することがこのモジュールの責務。
 *
 * 重要: ここで得られる祖先（`ancestorsOf`）は**表示（パンくず）と検索スコープのため**にあり、
 * 取次のフォールバック先ではない。上位組織への取次は #374 の RoutingPolicy で明示的に
 * 宣言する（issue #373 設計方針「組織の親子関係と取次フォールバックを同一視しない」）。
 */
import type { OrganizationUnit } from './types';

/**
 * 組織階層の最大深度（ルート = 1）。
 * 会社 > 本部 > 部 > 課 > 係 を想定した実務上の上限。これを超える階層は検索・表示・
 * 取次の設定が破綻しやすく、走査コストも読めなくなるため拒否する。
 */
export const MAX_ORGANIZATION_DEPTH = 5;

export type HierarchyIssue =
  | { kind: 'duplicate_id'; organizationId: string }
  | { kind: 'missing_parent'; organizationId: string; parentId: string }
  | { kind: 'cycle'; organizationId: string }
  | { kind: 'cross_tenant_parent'; organizationId: string; parentId: string }
  | { kind: 'cross_site_parent'; organizationId: string; parentId: string }
  | { kind: 'max_depth_exceeded'; organizationId: string; depth: number };

function indexById(units: ReadonlyArray<OrganizationUnit>): Map<string, OrganizationUnit> {
  const map = new Map<string, OrganizationUnit>();
  for (const unit of units) {
    if (!map.has(unit.id)) map.set(unit.id, unit);
  }
  return map;
}

/**
 * 循環に含まれる組織 id を返す（無ければ null）。
 * 自己ループ（parentId === id）も循環として扱う。
 *
 * **本番コードからは使わない**。最初に見つけた 1 循環しか返さないため、複数の循環が
 * 同時に存在すると取りこぼす。検証・ツリー構築・付け替え判定はすべて全循環を返す
 * `findAllOrganizationCycleIds` を使うこと。この関数は「1 つの具体的な循環経路を人へ
 * 提示する」デバッグ・テスト用途に限る。
 */
export function findOrganizationCycle(units: ReadonlyArray<OrganizationUnit>): string[] | null {
  const byId = indexById(units);
  const settled = new Set<string>();

  for (const unit of units) {
    if (settled.has(unit.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: OrganizationUnit | undefined = unit;

    while (current !== undefined) {
      if (onPath.has(current.id)) {
        // path の該当位置から先が循環本体。
        const start = path.indexOf(current.id);
        return path.slice(start);
      }
      if (settled.has(current.id)) break;
      path.push(current.id);
      onPath.add(current.id);
      current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    }
    for (const id of path) settled.add(id);
  }
  return null;
}

/**
 * 循環に巻き込まれている**全**ノードの id を返す。
 *
 * 親ポインタのグラフは各ノードの出次数が高々 1（= functional graph）なので、
 * 「子を持たないノードを繰り返し取り除く」と最後に残るのが循環ノードちょうどになる。
 * `findOrganizationCycle` は最初の 1 循環しか返さないため、複数の循環が同時に存在すると
 * 取りこぼす（表示から組織が黙って消える原因になる）。検証とツリー構築はこちらを使う。
 */
export function findAllOrganizationCycleIds(
  units: ReadonlyArray<OrganizationUnit>,
): Set<string> {
  const byId = indexById(units);
  // 子の数（= 親ポインタで自分を指しているノード数）。
  const childCount = new Map<string, number>();
  for (const id of byId.keys()) childCount.set(id, 0);
  for (const unit of byId.values()) {
    const parentId = unit.parentId;
    if (parentId === undefined || !byId.has(parentId)) continue;
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
  }

  const remaining = new Set(byId.keys());
  const queue = [...remaining].filter((id) => (childCount.get(id) ?? 0) === 0);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || !remaining.has(id)) continue;
    remaining.delete(id);
    const parentId = byId.get(id)?.parentId;
    if (parentId === undefined || !remaining.has(parentId)) continue;
    const next = (childCount.get(parentId) ?? 0) - 1;
    childCount.set(parentId, next);
    if (next === 0) queue.push(parentId);
  }
  return remaining;
}

/** 循環していない前提で親を辿る内部走査（循環時は打ち切る）。 */
function walkAncestors(
  byId: Map<string, OrganizationUnit>,
  startId: string,
): OrganizationUnit[] {
  const chain: OrganizationUnit[] = [];
  const seen = new Set<string>([startId]);
  let parentId = byId.get(startId)?.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    chain.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return chain;
}

/**
 * 祖先をルートに近い順で返す（パンくず表示用。自分自身は含まない）。
 * 循環していても無限ループしない（既訪問で打ち切る）。
 */
export function ancestorsOf(
  units: ReadonlyArray<OrganizationUnit>,
  organizationId: string,
): OrganizationUnit[] {
  return walkAncestors(indexById(units), organizationId).reverse();
}

/** ルートを 1 とした深さ。組織が見つからなければ 0。 */
export function depthOf(units: ReadonlyArray<OrganizationUnit>, organizationId: string): number {
  const byId = indexById(units);
  if (!byId.has(organizationId)) return 0;
  return walkAncestors(byId, organizationId).length + 1;
}

/** 直下・間接を問わず子孫の id を返す（自分自身は含まない）。 */
export function descendantIdsOf(
  units: ReadonlyArray<OrganizationUnit>,
  organizationId: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.parentId === undefined) continue;
    const list = childrenOf.get(unit.parentId) ?? [];
    list.push(unit.id);
    childrenOf.set(unit.parentId, list);
  }
  const result: string[] = [];
  const seen = new Set<string>([organizationId]);
  const queue = [...(childrenOf.get(organizationId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}

/** 自分自身を含む部分木の高さ（葉 = 1）。 */
function subtreeHeight(units: ReadonlyArray<OrganizationUnit>, organizationId: string): number {
  const descendants = descendantIdsOf(units, organizationId);
  if (descendants.length === 0) return 1;
  const byId = indexById(units);
  const baseDepth = walkAncestors(byId, organizationId).length;
  let max = 1;
  for (const id of descendants) {
    max = Math.max(max, walkAncestors(byId, id).length - baseDepth + 1);
  }
  return max;
}

/**
 * 組織集合の構造的な問題を列挙する（空配列 = 妥当）。
 * 書き込み前の検証に使う。エラーを投げず、問題を全件返して呼び出し側が提示できるようにする。
 */
export function validateOrganizationHierarchy(
  units: ReadonlyArray<OrganizationUnit>,
): HierarchyIssue[] {
  const issues: HierarchyIssue[] = [];

  const seenIds = new Set<string>();
  for (const unit of units) {
    if (seenIds.has(unit.id)) {
      issues.push({ kind: 'duplicate_id', organizationId: unit.id });
    }
    seenIds.add(unit.id);
  }

  const byId = indexById(units);

  for (const unit of units) {
    if (unit.parentId === undefined) continue;
    if (unit.parentId === unit.id) {
      // 自己ループ。findOrganizationCycle でも拾えるが、単体でも明示する。
      continue;
    }
    const parent = byId.get(unit.parentId);
    if (parent === undefined) {
      issues.push({ kind: 'missing_parent', organizationId: unit.id, parentId: unit.parentId });
      continue;
    }
    if (parent.tenantId !== unit.tenantId) {
      issues.push({
        kind: 'cross_tenant_parent',
        organizationId: unit.id,
        parentId: parent.id,
      });
      continue;
    }
    // 親がテナント横断（siteId 未設定）なら、どのサイトの子も持てる。
    if (parent.siteId !== undefined && parent.siteId !== unit.siteId) {
      issues.push({ kind: 'cross_site_parent', organizationId: unit.id, parentId: parent.id });
    }
  }

  // 複数の循環が同時に存在しても全件報告する（1 つ直すたびに再検証、を避ける）。
  const cycleIds = findAllOrganizationCycleIds(units);
  if (cycleIds.size > 0) {
    for (const id of cycleIds) issues.push({ kind: 'cycle', organizationId: id });
    // 循環がある間は深度が定義できないので、深度検証は行わない。
    return issues;
  }

  for (const unit of units) {
    const depth = depthOf(units, unit.id);
    if (depth > MAX_ORGANIZATION_DEPTH) {
      issues.push({ kind: 'max_depth_exceeded', organizationId: unit.id, depth });
    }
  }

  return issues;
}

export type ParentChangeResult =
  | { ok: true }
  | { ok: false; issues: HierarchyIssue[] };

/**
 * 組織 `organizationId` の親を `nextParentId` へ付け替えてよいかを判定する。
 * 付け替え後の集合に対して階層検証を行うので、循環・深度超過・境界越えをまとめて防げる。
 * `nextParentId` が undefined（ルート化）は常に許可される。
 */
export function canSetParent(
  units: ReadonlyArray<OrganizationUnit>,
  organizationId: string,
  nextParentId: string | undefined,
): ParentChangeResult {
  const target = units.find((u) => u.id === organizationId);
  if (target === undefined) {
    return { ok: false, issues: [{ kind: 'missing_parent', organizationId, parentId: '' }] };
  }
  if (nextParentId === undefined) return { ok: true };

  const next = units.map((u) => (u.id === organizationId ? { ...u, parentId: nextParentId } : u));
  // 付け替えが引き起こす問題だけを見る。付け替え先を変えるのは organizationId の親エッジ
  // だけなので、この操作が新たに作りうる循環は必ず organizationId を含む。よって循環を含む
  // すべての問題は `organizationId` を主体として報告される（`findAllOrganizationCycleIds` は
  // 循環ノードを全件返す）。無関係な既存循環（別ノード主体）でこの付け替えをブロックしない。
  const issues = validateOrganizationHierarchy(next).filter(
    (i) => i.organizationId === organizationId,
  );
  // 付け替え先の部分木の高さも含めて深度上限を見る（子孫ごと動くため）。
  const parentDepth = depthOf(next, nextParentId);
  const height = subtreeHeight(units, organizationId);
  if (parentDepth > 0 && parentDepth + height > MAX_ORGANIZATION_DEPTH) {
    issues.push({
      kind: 'max_depth_exceeded',
      organizationId,
      depth: parentDepth + height,
    });
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export type OrganizationTreeNode = {
  unit: OrganizationUnit;
  children: OrganizationTreeNode[];
};

/**
 * 親子構造を `displayOrder` → `id` 順で組み立てる。
 * 親が集合内に無い組織（scope 外の親を持つ・孤児）はルートへ昇格させ、**落とさない**。
 * 循環している組織も同様にルートへ昇格させる（表示から消えて所在不明になるのを避ける）。
 */
export function buildOrganizationTree(
  units: ReadonlyArray<OrganizationUnit>,
): OrganizationTreeNode[] {
  // 循環ノードは**全件**取得する。取りこぼすと、その循環のノードが roots にも children にも
  // 入らず出力から消える（管理画面で組織が理由なく消える障害になる）。
  const cycleIds = findAllOrganizationCycleIds(units);

  const nodes = new Map<string, OrganizationTreeNode>();
  for (const unit of units) {
    if (!nodes.has(unit.id)) nodes.set(unit.id, { unit, children: [] });
  }

  const roots: OrganizationTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parentId = node.unit.parentId;
    // 循環ノードはルートへ昇格させる（親リンクを切るので互いに入れ子にならない）。
    // `cycleIds` は `findAllOrganizationCycleIds` が全循環ノードを返すので、循環に属する
    // ノードは 1 つ残らずここでルート化され、どの親の children にも入らない。したがって
    // children グラフに循環は生じず、下の `sort` が無限再帰することはない。
    const parentNode =
      parentId === undefined || cycleIds.has(id) ? undefined : nodes.get(parentId);
    if (parentNode === undefined) {
      roots.push(node);
    } else {
      parentNode.children.push(node);
    }
  }

  // NOTE(#396): 以前ここに「roots から到達できないノードをルートへ戻す」防御ブロックがあった。
  // `findAllOrganizationCycleIds` が完全なため到達不能ノードは生じず、このブロックは常に
  // デッドコードだった。しかも発火時は昇格ノードを親の children から外さないため children
  // グラフに循環が残り、`sort` が無限再帰してクラッシュする（`[a↔b, c↔d]` で Maximum call
  // stack）。実害のある死蔵コードなので削除した。全循環ノードが確実に root 化されること・
  // ノードが 1 件も欠落/重複しないことは buildOrganizationTree のテストで担保する。

  const sort = (list: OrganizationTreeNode[]): void => {
    list.sort(
      (a, b) => a.unit.displayOrder - b.unit.displayOrder || a.unit.id.localeCompare(b.unit.id),
    );
    for (const child of list) sort(child.children);
  };
  sort(roots);
  return roots;
}
