/**
 * 現行フラットモデル（`Department` / `Staff.departmentId`）→ 階層組織モデルの
 * compatibility reader (issue #373)。
 *
 * **加算的で非破壊**であることがこのモジュールの契約:
 *   - 既存の `Department` / `Staff` の型・永続データを一切変更しない（読むだけ）。
 *   - 部署 id をそのまま組織 id に使うので、既存の `staff.departmentId` 参照が生き続ける。
 *   - `staff.departmentId` は `relation: 'primary'` の所属として読める。
 *
 * 段階移行の想定: 当面は本 reader が返す互換組織を土台にし、階層・公開名を編集したものだけを
 * `OrganizationUnit` として保存する。`mergeOrganizationUnits` で保存済みが互換由来を上書きする。
 * 既存データの一括 migration（書き換え）は本モジュールでは行わない。
 */
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import type { OrganizationMembership, OrganizationScope, OrganizationUnit } from './types';

/** 部署 1 件を、フラット（ルート）な組織として読む。 */
export function organizationUnitFromDepartment(
  department: Department,
  scope: OrganizationScope,
): OrganizationUnit {
  return {
    id: department.id,
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    // フラットモデルには階層が無いので、移行時点では全てルート。
    parentId: undefined,
    // 名称は移行時点では分離できない。運用で publicDisplayName を編集していく。
    officialName: department.name,
    publicDisplayName: department.name,
    aliases: [],
    kana: department.kana,
    displayOrder: department.displayOrder,
    enabled: department.enabled,
    publicInDirectory: true,
  };
}

/**
 * 担当者 1 件の `departmentId` を主所属として読む（`departmentId` が空なら undefined）。
 *
 * 注意: `staff.fallbackStaffIds` は**代理担当へ昇格させない**。既存の fallback は呼び出しの
 * 導線であって「誰の代理か」の設定ではなく、意味を変えると #374 の RoutingPolicy と
 * 二重定義になる。代理担当（`relation: 'acting'`）は明示的に設定されたものだけを扱う。
 */
export function membershipFromStaff(member: Staff): OrganizationMembership | undefined {
  if (member.departmentId.trim() === '') return undefined;
  return {
    staffId: member.id,
    organizationId: member.departmentId,
    relation: 'primary',
    publicInDirectory: member.enabled,
    callable: member.enabled,
  };
}

export type OrganizationCompatInput = {
  departments: ReadonlyArray<Department>;
  staff: ReadonlyArray<Staff>;
};

export type OrganizationCompatResult = {
  units: OrganizationUnit[];
  memberships: OrganizationMembership[];
  /** 存在しない部署を指していて所属を解決できなかった担当者 id（運用で検知するため）。 */
  unresolvedStaffIds: string[];
};

/**
 * 現行の部署・担当者を階層組織モデルとして読む。入力は変更しない。
 * 部署が解決できない担当者の所属は落とし、`unresolvedStaffIds` として返す
 * （不整合をそのまま階層へ持ち込まない）。
 */
export function readOrganizationCompat(
  input: OrganizationCompatInput,
  scope: OrganizationScope,
): OrganizationCompatResult {
  const units = input.departments.map((d) => organizationUnitFromDepartment(d, scope));
  const unitIds = new Set(units.map((u) => u.id));

  const memberships: OrganizationMembership[] = [];
  const unresolvedStaffIds: string[] = [];
  for (const member of input.staff) {
    const membership = membershipFromStaff(member);
    if (membership === undefined) continue;
    if (!unitIds.has(membership.organizationId)) {
      unresolvedStaffIds.push(member.id);
      continue;
    }
    memberships.push(membership);
  }
  return { units, memberships, unresolvedStaffIds };
}

/**
 * 互換組織（部署由来）に、保存済みの組織定義を重ねる。同一 id は**保存済みが勝つ**。
 * これにより「部署はそのまま・階層化したものだけ保存」という段階移行ができる。
 */
export function mergeOrganizationUnits(
  compatUnits: ReadonlyArray<OrganizationUnit>,
  storedUnits: ReadonlyArray<OrganizationUnit>,
): OrganizationUnit[] {
  const merged = new Map<string, OrganizationUnit>();
  for (const unit of compatUnits) merged.set(unit.id, unit);
  for (const unit of storedUnits) merged.set(unit.id, unit);
  return [...merged.values()];
}
