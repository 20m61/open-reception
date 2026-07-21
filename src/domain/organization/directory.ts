/**
 * 組織ディレクトリの参照ロジック (issue #373)。
 *
 * 公開面（来訪者）と内部面（管理）の境界をここで引く。**境界は boolean フラグではなく型で引く**:
 * 来訪者経路は `VisitorOrganization` / `VisitorStaffAffiliation` しか扱えず、`officialName` を
 * 構造的に持てない。以前は `visitorFacing: true` オプションで生の `OrganizationUnit` を返して
 * いたため、祖先経由で内部正式名称と非公開組織名が来訪者ラベルへ漏れていた
 * （`.claude/rules/pii-secret-minimization.md`）。
 *
 * また、**組織の親子関係で自動的に取次先を広げない**。`listCallableMembers` は指定した
 * 組織に直接ぶら下がる所属だけを返し、親へも子へも遡らない。上位組織への fallback は
 * #374 の RoutingPolicy が明示的に宣言する。
 */
import { searchStaffScored } from '@/domain/staff/search';
import { ancestorsOf } from './hierarchy';
import type {
  OrganizationMembership,
  OrganizationRelation,
  OrganizationScope,
  OrganizationUnit,
} from './types';
import { scopeOrganizationUnits } from './types';

/** 来訪者へ渡してよい組織の形。内部正式名称を**構造的に**含まない。 */
export type VisitorOrganization = {
  id: string;
  /** 公開表示名。 */
  name: string;
  /**
   * 親組織 id。**公開集合内に親が居る場合のみ**設定する。
   * 非公開の親 id を来訪者へ渡すと、内部専用組織の存在と識別子が漏れるため。
   */
  parentId?: string;
};

/**
 * 来訪者向けのビューへ落とす（`officialName` は落ちる）。
 * `publicIds` を渡すと、その集合に含まれない親への `parentId` を落とす。
 */
export function toVisitorOrganization(
  unit: OrganizationUnit,
  publicIds?: ReadonlySet<string>,
): VisitorOrganization {
  const parentId =
    unit.parentId !== undefined && (publicIds === undefined || publicIds.has(unit.parentId))
      ? unit.parentId
      : undefined;
  return { id: unit.id, name: unit.publicDisplayName, parentId };
}

/** 公開・有効かつ scope 境界内の組織だけを返す。 */
function publicUnitsInScope(
  units: ReadonlyArray<OrganizationUnit>,
  scope: OrganizationScope,
): OrganizationUnit[] {
  return scopeOrganizationUnits(units, scope).filter((u) => u.enabled && u.publicInDirectory);
}

function toVisitorList(units: ReadonlyArray<OrganizationUnit>): VisitorOrganization[] {
  const publicIds = new Set(units.map((u) => u.id));
  return units.map((u) => toVisitorOrganization(u, publicIds));
}

/** 来訪者向け組織一覧。 */
export function listVisitorOrganizations(
  units: ReadonlyArray<OrganizationUnit>,
  scope: OrganizationScope,
): VisitorOrganization[] {
  return toVisitorList(publicUnitsInScope(units, scope));
}

/**
 * 来訪者向けの組織検索。担当者検索（`searchStaffScored`）と同じ表記ゆれ耐性を使い、
 * 公開表示名・よみ・別名だけを対象にする（内部正式名称からは引けない）。
 */
export function searchVisitorOrganizations(
  units: ReadonlyArray<OrganizationUnit>,
  query: string,
  scope: OrganizationScope,
): VisitorOrganization[] {
  const candidates = publicUnitsInScope(units, scope);
  if (query.trim() === '') return toVisitorList(candidates);
  const publicIds = new Set(candidates.map((u) => u.id));
  const searchable = candidates.map((u) => ({
    displayName: u.publicDisplayName,
    kana: u.kana,
    aliases: u.aliases,
    unit: u,
  }));
  return searchStaffScored(searchable, query).map((m) =>
    toVisitorOrganization(m.item.unit, publicIds),
  );
}

/** 1 件の所属（組織 + 関係 + 表示用の祖先）。**内部向け**（`officialName` を含む）。 */
export type StaffAffiliation = {
  unit: OrganizationUnit;
  membership: OrganizationMembership;
  /**
   * ルートに近い順の祖先。**表示（パンくず）専用**であり、取次のフォールバック先ではない。
   */
  ancestors: OrganizationUnit[];
};

export type StaffAffiliations = {
  /** 主所属（最大 1 件）。 */
  primary?: StaffAffiliation;
  /** 兼務。 */
  secondary: StaffAffiliation[];
  /** この担当者が代理を務めている所属（`now` 時点で有効期間内のもののみ）。 */
  acting: StaffAffiliation[];
};

export type AffiliationQuery = {
  /**
   * 有効期間の判定時刻（ISO 8601）。**必須**。任意にすると呼び忘れで期限切れの代理担当が
   * そのまま所属・呼び出し候補へ混ざる。
   */
  now: string;
  /** 省略時は境界で絞らない（呼び出し側が絞り済みの集合を渡す場合のみ）。 */
  scope?: OrganizationScope;
};

/**
 * 担当者の所属を主所属・兼務・代理へ分解する（**内部向け**）。
 * `scope` を渡すと境界外（他 tenant/site）の組織の所属を落とす。
 * `relation: 'acting'` は `now` 時点で有効期間内のものだけを返す。
 *
 * 来訪者へ出すときは必ず `toVisitorAffiliations` を通すこと。
 */
export function resolveStaffAffiliations(
  memberships: ReadonlyArray<OrganizationMembership>,
  units: ReadonlyArray<OrganizationUnit>,
  staffId: string,
  query: AffiliationQuery,
): StaffAffiliations {
  const visible =
    query.scope === undefined ? [...units] : scopeOrganizationUnits(units, query.scope);
  const byId = new Map(visible.map((u) => [u.id, u]));

  const result: StaffAffiliations = { secondary: [], acting: [] };
  for (const membership of memberships) {
    if (membership.staffId !== staffId) continue;
    const unit = byId.get(membership.organizationId);
    if (unit === undefined) continue;

    const affiliation: StaffAffiliation = {
      unit,
      membership,
      ancestors: ancestorsOf(visible, unit.id),
    };
    if (membership.relation === 'primary') {
      // 主所属は最大 1 件。既に在る場合は最初のものを正とする。
      result.primary ??= affiliation;
    } else if (membership.relation === 'secondary') {
      result.secondary.push(affiliation);
    } else if (isActiveAt(membership, query.now)) {
      result.acting.push(affiliation);
    }
  }
  return result;
}

/** 来訪者へ渡してよい所属。`officialName` を構造的に持たない。 */
export type VisitorStaffAffiliation = {
  unit: VisitorOrganization;
  relation: OrganizationRelation;
  /** 公開かつ連続した祖先のみ（ルートに近い順）。表示専用。 */
  ancestors: VisitorOrganization[];
};

export type VisitorStaffAffiliations = {
  primary?: VisitorStaffAffiliation;
  secondary: VisitorStaffAffiliation[];
  acting: VisitorStaffAffiliation[];
};

function isPublic(unit: OrganizationUnit): boolean {
  return unit.enabled && unit.publicInDirectory;
}

function toVisitorAffiliation(affiliation: StaffAffiliation): VisitorStaffAffiliation | undefined {
  if (!isPublic(affiliation.unit)) return undefined;
  if (!affiliation.membership.publicInDirectory) return undefined;

  // 自分に近い側から公開の祖先だけを採り、非公開の祖先に当たったら打ち切る。
  // 飛ばして繋ぐと、実際には親子でない組織を親子として見せてしまうため。
  const publicChain: OrganizationUnit[] = [];
  for (let i = affiliation.ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = affiliation.ancestors[i];
    if (ancestor === undefined || !isPublic(ancestor)) break;
    publicChain.unshift(ancestor);
  }
  const publicIds = new Set([...publicChain.map((u) => u.id), affiliation.unit.id]);
  return {
    unit: toVisitorOrganization(affiliation.unit, publicIds),
    relation: affiliation.membership.relation,
    ancestors: publicChain.map((u) => toVisitorOrganization(u, publicIds)),
  };
}

/**
 * 内部向けの所属を来訪者向けへ落とす。非公開・無効な組織と、非公開の所属はここで落ちる。
 * 来訪者へ出す表示は必ずこの関数を通すこと（以降は型として `officialName` を持てない）。
 */
export function toVisitorAffiliations(affiliations: StaffAffiliations): VisitorStaffAffiliations {
  const toList = (list: ReadonlyArray<StaffAffiliation>): VisitorStaffAffiliation[] =>
    list.map(toVisitorAffiliation).filter((a): a is VisitorStaffAffiliation => a !== undefined);
  return {
    primary:
      affiliations.primary === undefined ? undefined : toVisitorAffiliation(affiliations.primary),
    secondary: toList(affiliations.secondary),
    acting: toList(affiliations.acting),
  };
}

export type AffiliationLabelOptions = {
  /** true のとき主所属を「親 / 子」のパンくずで表示する（公開の祖先のみ）。 */
  includeAncestors?: boolean;
};

/**
 * 同姓同名の候補を識別するための所属ラベル。
 * 引数が `VisitorStaffAffiliations` なので、内部正式名称は**型として渡ってこない**。
 * 例: `営業部（兼: 開発部）` / `営業部 / 営業一課`
 */
export function affiliationSummaryLabel(
  affiliations: VisitorStaffAffiliations,
  options: AffiliationLabelOptions = {},
): string {
  const primary = affiliations.primary;
  if (primary === undefined) {
    const first = affiliations.secondary[0];
    return first === undefined ? '' : first.unit.name;
  }
  const path =
    options.includeAncestors === true
      ? [...primary.ancestors, primary.unit].map((u) => u.name).join(' / ')
      : primary.unit.name;
  if (affiliations.secondary.length === 0) return path;
  const also = affiliations.secondary.map((a) => a.unit.name).join('・');
  return `${path}（兼: ${also}）`;
}

const RELATION_ORDER = { primary: 0, secondary: 1, acting: 2 } as const;

/**
 * 指定した組織で呼び出してよい所属を返す（主所属 → 兼務 → 代理の順）。
 *
 * **親組織へも子組織へも遡らない**。組織の親子関係と取次フォールバックを同一視しないため
 * （issue #373 設計方針）。上位への取次が要るなら #374 の RoutingPolicy で明示する。
 *
 * `relation: 'acting'` は `now` 時点で有効期間内のものだけを返す。#374 の RoutingPolicy が
 * 取次候補を引くときに最初に叩く関数なので、ここで期間を評価しないと期限切れの代理担当へ
 * 取次いでしまう。そのため `now` は必須にしている。
 */
export function listCallableMembers(
  memberships: ReadonlyArray<OrganizationMembership>,
  units: ReadonlyArray<OrganizationUnit>,
  organizationId: string,
  query: AffiliationQuery,
): OrganizationMembership[] {
  const visible =
    query.scope === undefined ? [...units] : scopeOrganizationUnits(units, query.scope);
  const unit = visible.find((u) => u.id === organizationId);
  if (unit === undefined || !unit.enabled) return [];
  return memberships
    .filter((m) => m.organizationId === organizationId && m.callable)
    .filter((m) => m.relation !== 'acting' || isActiveAt(m, query.now))
    .sort((a, b) => RELATION_ORDER[a.relation] - RELATION_ORDER[b.relation]);
}

export type ActingQuery = {
  /** 誰の代理かで引く。 */
  actingForStaffId?: string;
  /** どの組織の代理かで引く。 */
  organizationId?: string;
  /** 有効期間の判定時刻（ISO 8601）。 */
  now: string;
};

/**
 * 有効期間の判定。ISO 8601 文字列を `Date.parse` で比較する。
 *
 * 辞書順比較にしないのは、`...T00:00:00Z` と `...T09:00:00+09:00` のようにオフセット表記が
 * 混ざると誤判定するため。解釈できない値は **inactive 扱い（fail-closed）** にする
 * — 壊れた期間指定で代理担当が無期限に有効化される方が危険なので。
 */
export function isActiveAt(membership: OrganizationMembership, now: string): boolean {
  const at = Date.parse(now);
  if (Number.isNaN(at)) return false;
  if (membership.validFrom !== undefined) {
    const from = Date.parse(membership.validFrom);
    if (Number.isNaN(from) || at < from) return false;
  }
  if (membership.validUntil !== undefined) {
    const until = Date.parse(membership.validUntil);
    if (Number.isNaN(until) || at > until) return false;
  }
  return true;
}

/**
 * 代理担当（`relation: 'acting'`）を明示的に引く。
 * 代理は暗黙のフォールバックではなく設定された事実なので、期間内のものだけを返す。
 */
export function resolveActingMembers(
  memberships: ReadonlyArray<OrganizationMembership>,
  units: ReadonlyArray<OrganizationUnit>,
  query: ActingQuery,
  scope?: OrganizationScope,
): OrganizationMembership[] {
  const visible = scope === undefined ? [...units] : scopeOrganizationUnits(units, scope);
  const enabledIds = new Set(visible.filter((u) => u.enabled).map((u) => u.id));
  return memberships.filter((m) => {
    if (m.relation !== 'acting') return false;
    if (!enabledIds.has(m.organizationId)) return false;
    if (query.actingForStaffId !== undefined && m.actingForStaffId !== query.actingForStaffId) {
      return false;
    }
    if (query.organizationId !== undefined && m.organizationId !== query.organizationId) {
      return false;
    }
    return isActiveAt(m, query.now);
  });
}
