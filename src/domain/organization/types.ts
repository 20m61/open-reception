/**
 * 階層組織ドメイン型 (issue #373)。
 *
 * 現行の `Department`（`src/domain/department/types.ts`）と `Staff.departmentId`
 * （フラットな単一所属）を壊さずに**加算的**へ拡張するための型。既存データは
 * `compat.ts` の compatibility reader で本モデルとして読める。
 *
 * 設計方針（issue #373）:
 *   - 組織の親子関係と**取次フォールバックを同一視しない**。上位組織への fallback は
 *     #374 の RoutingPolicy で明示する。本モジュールは親子＝表示・検索・所属の構造のみを表す。
 *   - 来訪者向け表示名（`publicDisplayName`）と内部正式名称（`officialName`）を分離する。
 *   - 循環する組織階層を拒否する（`hierarchy.ts`）。
 *   - tenant/site 境界を維持する。scope はサーバ側で解決した actor から作り、
 *     クライアントが送る tenantId をそのまま信用しない（`.claude/rules/admin-api-authz.md`）。
 */

/** 担当者と組織の関係。 */
export type OrganizationRelation =
  /** 主所属。1 担当者につき最大 1 件。 */
  | 'primary'
  /** 兼務。複数持てる。 */
  | 'secondary'
  /** 代理担当。`actingForStaffId` で誰の代理かを明示する。 */
  | 'acting';

export const ORGANIZATION_RELATIONS: OrganizationRelation[] = ['primary', 'secondary', 'acting'];

export function isOrganizationRelation(value: unknown): value is OrganizationRelation {
  return typeof value === 'string' && (ORGANIZATION_RELATIONS as string[]).includes(value);
}

/** 階層組織のノード。 */
export type OrganizationUnit = {
  id: string;
  tenantId: string;
  /**
   * 所属サイト。未設定はテナント横断組織（どのサイトからも参照できる）。
   * 子は親と同一サイトか、親がテナント横断である必要がある（`hierarchy.ts` で検証）。
   */
  siteId?: string;
  /** 親組織 id。未設定はルート。 */
  parentId?: string;
  /** 内部正式名称。来訪者へは出さない。 */
  officialName: string;
  /** 来訪者向け表示名。kiosk などの公開面ではこちらのみを使う。 */
  publicDisplayName: string;
  /** 検索用別名（英字表記・旧称・略称など）。 */
  aliases: string[];
  /** 検索用よみ。 */
  kana?: string;
  displayOrder: number;
  /** 無効化された組織は検索・表示・呼び出しの対象外。 */
  enabled: boolean;
  /** 来訪者ディレクトリへ掲載してよいか（内部専用組織を隠すため）。 */
  publicInDirectory: boolean;
};

/** 担当者の組織所属（主所属・兼務・代理担当）。 */
export type OrganizationMembership = {
  staffId: string;
  organizationId: string;
  relation: OrganizationRelation;
  /** 来訪者ディレクトリへこの所属を掲載してよいか。 */
  publicInDirectory: boolean;
  /** この所属経由で呼び出してよいか。 */
  callable: boolean;
  /**
   * `relation: 'acting'` のとき、誰の代理かを示す staff id。
   * 代理担当は「暗黙のフォールバック」ではなく明示的な設定として表現する。
   */
  actingForStaffId?: string;
  /** 代理担当の有効期間（ISO 8601）。未設定は無期限。 */
  validFrom?: string;
  validUntil?: string;
};

/**
 * 参照可能な tenant/site 境界。サーバ側で解決した actor から作る。
 * `siteId` 未設定はテナント全体（テナント横断組織 + 全サイト）を指す。
 */
export type OrganizationScope = {
  tenantId: string;
  siteId?: string;
};

/** 組織が scope の境界内かを判定する（テナント横断組織は同一テナントの全サイトから見える）。 */
export function isWithinScope(unit: OrganizationUnit, scope: OrganizationScope): boolean {
  if (unit.tenantId !== scope.tenantId) return false;
  if (scope.siteId === undefined) return true;
  return unit.siteId === undefined || unit.siteId === scope.siteId;
}

/** scope 境界内の組織だけへ絞り込む。境界越えの参照はここで落とす。 */
export function scopeOrganizationUnits(
  units: ReadonlyArray<OrganizationUnit>,
  scope: OrganizationScope,
): OrganizationUnit[] {
  return units.filter((u) => isWithinScope(u, scope));
}
