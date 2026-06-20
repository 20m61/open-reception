/**
 * テナント/サイト境界の認可判定 (issue #80, increment 1)。
 *
 * すべて純関数。middleware / route / 端末 API から再利用し、テーブルテストで網羅する。
 * 方針（docs/multitenant-design.md §認可）:
 *   - クライアントが送る tenantId をそのまま信用しない。actor の RoleAssignment を正とする。
 *   - developer 以外は他テナントのデータへアクセスできない。
 *   - 書き込みは viewer/kiosk_device 以外。viewer は読み取り専用。
 *   - 既存 src/domain/auth/roles.ts（Entra App Role 写像）とは責務が異なる:
 *     roles.ts は「認証ソースのロール → 管理ロール」の写像、本モジュールは
 *     「解決済みロール × テナント/サイト境界」の認可判定。重複定義はしない。
 */
import type {
  AdminUser,
  DeviceId,
  RoleAssignment,
  SiteId,
  TenantId,
  TenantRole,
} from './types';

/** 認可判定の主体。AdminUser そのもの、もしくは解決済みの割り当て集合。 */
export type Actor = Pick<AdminUser, 'assignments' | 'status'>;

/** 操作の種別。read=閲覧、write=作成/更新/失効など。 */
export type Operation = 'read' | 'write';

/** 書き込みを行えるロールか（viewer / kiosk_device は読み取りのみ）。 */
export function canRoleWrite(role: TenantRole): boolean {
  return role === 'developer' || role === 'tenant_admin' || role === 'site_manager';
}

/** developer は全テナント横断。 */
function isDeveloper(a: RoleAssignment): boolean {
  return a.role === 'developer';
}

function activeAssignments(actor: Actor): RoleAssignment[] {
  if (actor.status !== 'active') return [];
  return actor.assignments;
}

/**
 * actor が指定テナントにアクセスできるか（read 既定）。
 * developer は常に true。それ以外は当該テナントの割り当てが必要。
 * write の場合は書き込み可能ロールの割り当てが必要。
 */
export function canAccessTenant(
  actor: Actor,
  tenantId: TenantId,
  op: Operation = 'read',
): boolean {
  for (const a of activeAssignments(actor)) {
    if (isDeveloper(a)) {
      if (op === 'read' || canRoleWrite(a.role)) return true;
      continue;
    }
    if (a.tenantId !== tenantId) continue;
    if (op === 'write' && !canRoleWrite(a.role)) continue;
    return true;
  }
  return false;
}

/**
 * actor が指定サイトにアクセスできるか（read 既定）。
 * - developer: 常に可。
 * - tenant_admin: 自テナントの全サイト。
 * - site_manager: 当該サイトに割り当てがある場合のみ。
 * - viewer: 自テナント（siteId 指定なし）または当該サイト指定の割り当て。
 * write は書き込み可能ロールに限る。
 */
export function canAccessSite(
  actor: Actor,
  tenantId: TenantId,
  siteId: SiteId,
  op: Operation = 'read',
): boolean {
  for (const a of activeAssignments(actor)) {
    if (isDeveloper(a)) {
      if (op === 'read' || canRoleWrite(a.role)) return true;
      continue;
    }
    if (a.tenantId !== tenantId) continue;
    if (op === 'write' && !canRoleWrite(a.role)) continue;
    // テナント全体スコープ（siteId=null）は配下の全サイトを含む。
    if (a.siteId === null) return true;
    if (a.siteId === siteId) return true;
  }
  return false;
}

/**
 * 受付端末 API 用の境界検証。端末トークンが主張する tenantId/siteId/deviceId が、
 * actor（kiosk_device 割り当て）の束縛と完全一致するかを確認する。
 * developer/管理ロールでは false（端末 API は端末ロール専用）。
 */
export function canDeviceAct(
  actor: Actor,
  tenantId: TenantId,
  siteId: SiteId,
  deviceId: DeviceId,
): boolean {
  for (const a of activeAssignments(actor)) {
    if (a.role !== 'kiosk_device') continue;
    if (a.tenantId === tenantId && a.siteId === siteId && a.deviceId === deviceId) return true;
  }
  return false;
}

/**
 * actor がアクセスできるテナント ID の集合を返す。
 * developer は全テナント横断のため特別扱い（呼び出し側が「全件」を意味すると解釈する）。
 */
export type AccessibleTenants =
  | { scope: 'all' }
  | { scope: 'tenants'; tenantIds: TenantId[] };

export function accessibleTenants(actor: Actor): AccessibleTenants {
  const ids = new Set<TenantId>();
  for (const a of activeAssignments(actor)) {
    if (isDeveloper(a)) return { scope: 'all' };
    if (a.tenantId !== null) ids.add(a.tenantId);
  }
  return { scope: 'tenants', tenantIds: [...ids] };
}
