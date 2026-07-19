/**
 * 組織ディレクトリの参照ロジック (issue #373)。
 *
 * 公開面（来訪者）と内部面（管理）の境界をここで引く:
 *   - 来訪者へは `publicDisplayName` のみを渡し、`officialName` を含む型を返さない。
 *   - 検索対象も公開表示名・よみ・別名に限る（内部正式名称から組織を推測させない）。
 *
 * また、**組織の親子関係で自動的に取次先を広げない**。`listCallableMembers` は指定した
 * 組織に直接ぶら下がる所属だけを返し、親へも子へも遡らない。上位組織への fallback は
 * #374 の RoutingPolicy が明示的に宣言する。
 */
import { searchStaffScored } from '@/domain/staff/search';
import { ancestorsOf } from './hierarchy';
import type { OrganizationMembership, OrganizationScope, OrganizationUnit } from './types';
import { scopeOrganizationUnits } from './types';

/** 来訪者へ渡してよい組織の形。内部正式名称を**構造的に**含まない。 */
export type VisitorOrganization = {
  id: string;
  /** 公開表示名。 */
  name: string;
  parentId?: string;
};

/** 来訪者向けのビューへ落とす（`officialName` は落ちる）。 */
export function toVisitorOrganization(unit: OrganizationUnit): VisitorOrganization {
  return { id: unit.id, name: unit.publicDisplayName, parentId: unit.parentId };
}

/** 公開・有効かつ scope 境界内の組織だけを返す。 */
function publicUnitsInScope(
  units: ReadonlyArray<OrganizationUnit>,
  scope: OrganizationScope,
): OrganizationUnit[] {
  return scopeOrganizationUnits(units, scope).filter((u) => u.enabled && u.publicInDirectory);
}

/** 来訪者向け組織一覧（displayOrder 順を維持せず入力順。並べ替えは呼び出し側かツリー構築で行う）。 */
export function listVisitorOrganizations(
  units: ReadonlyArray<OrganizationUnit>,
  scope: OrganizationScope,
): VisitorOrganization[] {
  return publicUnitsInScope(units, scope).map(toVisitorOrganization);
}

/**
 * 来訪者向けの組織検索。担当者検索（`searchStaffScored`）と同じ表記ゆれ耐性を使い、
 * 公開表示名・よみ・別名だけを対象にする。
 */
export function searchVisitorOrganizations(
  units: ReadonlyArray<OrganizationUnit>,
  query: string,
  scope: OrganizationScope,
): VisitorOrganization[] {
  const candidates = publicUnitsInScope(units, scope);
  if (query.trim() === '') return candidates.map(toVisitorOrganization);
  const searchable = candidates.map((u) => ({
    displayName: u.publicDisplayName,
    kana: u.kana,
    aliases: u.aliases,
    unit: u,
  }));
  return searchStaffScored(searchable, query).map((m) => toVisitorOrganization(m.item.unit));
}

/** 1 件の所属（組織 + 関係 + 表示用の祖先）。 */
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
  /** この担当者が代理を務めている所属。 */
  acting: StaffAffiliation[];
};

export type AffiliationOptions = {
  /** true のとき `publicInDirectory: false` の所属を除外する（来訪者向け）。 */
  visitorFacing?: boolean;
};

/**
 * 担当者の所属を主所属・兼務・代理へ分解する。
 * `scope` を渡すと境界外（他 tenant/site）の組織の所属を落とす。
 */
export function resolveStaffAffiliations(
  memberships: ReadonlyArray<OrganizationMembership>,
  units: ReadonlyArray<OrganizationUnit>,
  staffId: string,
  scope?: OrganizationScope,
  options: AffiliationOptions = {},
): StaffAffiliations {
  const visible = scope === undefined ? [...units] : scopeOrganizationUnits(units, scope);
  const byId = new Map(visible.map((u) => [u.id, u]));

  const result: StaffAffiliations = { secondary: [], acting: [] };
  for (const membership of memberships) {
    if (membership.staffId !== staffId) continue;
    if (options.visitorFacing === true && !membership.publicInDirectory) continue;
    const unit = byId.get(membership.organizationId);
    if (unit === undefined) continue;
    if (options.visitorFacing === true && (!unit.enabled || !unit.publicInDirectory)) continue;

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
    } else {
      result.acting.push(affiliation);
    }
  }
  return result;
}

export type AffiliationLabelOptions = {
  /** true のとき主所属を「親 / 子」のパンくずで表示する。 */
  includeAncestors?: boolean;
};

/**
 * 同姓同名の候補を識別するための所属ラベル（来訪者向け・公開表示名のみ）。
 * 例: `営業部（兼: 開発部）` / `営業部 / 営業一課`
 */
export function affiliationSummaryLabel(
  affiliations: StaffAffiliations,
  options: AffiliationLabelOptions = {},
): string {
  const primary = affiliations.primary;
  if (primary === undefined) {
    const first = affiliations.secondary[0];
    return first === undefined ? '' : first.unit.publicDisplayName;
  }
  const path =
    options.includeAncestors === true
      ? [...primary.ancestors, primary.unit].map((u) => u.publicDisplayName).join(' / ')
      : primary.unit.publicDisplayName;
  if (affiliations.secondary.length === 0) return path;
  const also = affiliations.secondary.map((a) => a.unit.publicDisplayName).join('・');
  return `${path}（兼: ${also}）`;
}

const RELATION_ORDER = { primary: 0, secondary: 1, acting: 2 } as const;

/**
 * 指定した組織で呼び出してよい所属を返す（主所属 → 兼務 → 代理の順）。
 *
 * **親組織へも子組織へも遡らない**。組織の親子関係と取次フォールバックを同一視しないため
 * （issue #373 設計方針）。上位への取次が要るなら #374 の RoutingPolicy で明示する。
 */
export function listCallableMembers(
  memberships: ReadonlyArray<OrganizationMembership>,
  units: ReadonlyArray<OrganizationUnit>,
  organizationId: string,
  scope?: OrganizationScope,
): OrganizationMembership[] {
  const visible = scope === undefined ? [...units] : scopeOrganizationUnits(units, scope);
  const unit = visible.find((u) => u.id === organizationId);
  if (unit === undefined || !unit.enabled) return [];
  return memberships
    .filter((m) => m.organizationId === organizationId && m.callable)
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

function isActiveAt(membership: OrganizationMembership, now: string): boolean {
  if (membership.validFrom !== undefined && now < membership.validFrom) return false;
  if (membership.validUntil !== undefined && now > membership.validUntil) return false;
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
