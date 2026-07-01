/**
 * 管理画面エリアの route guard 雛形 (issue #85, increment 1)。
 *
 * #80 の `src/domain/tenant/authorization.ts` を土台に、ルートエリア
 * （`/admin` / `/platform`）単位のアクセス可否を純関数で判定する。
 *
 * 重要（#85 セキュリティ方針）:
 *   - これは UX 上の「入口ガード」であり、最終的な認可は必ず API 側で
 *     `role` / `tenantId` / `siteId` / `permission` を検証して行う。
 *   - 本モジュールは I/O を持たない。実際の actor 解決（セッション→AdminUser）は
 *     呼び出し側（layout / middleware）が行い、結果を本関数へ渡す。
 *
 * 厳密な各画面適用は次増分。ここでは雛形と適用例（admin layout）を 1 箇所示す。
 */
import type { Actor, Operation } from '@/domain/tenant/authorization';
import {
  accessibleTenants,
  canAccessSite,
  canAccessTenant,
} from '@/domain/tenant/authorization';
import type { SiteId, TenantId } from '@/domain/tenant/types';

/** ガード対象のルートエリア。 */
export type AdminArea = 'admin' | 'platform';

/** ガード判定の結果。拒否時は理由を添える（ログ/監査の手掛かり）。 */
export type GuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden-area' };

/**
 * actor が指定エリアへ入れるか。
 *   - 未認証 / 非 active            → unauthenticated。
 *   - `/platform`                   → developer（全テナント横断）のみ。
 *   - `/admin`                      → 何らかのテナント割り当てを持つ（=閲覧できる）こと。
 *
 * テナント/サイト単位の細粒度の認可は各画面で canAccessTenant/canAccessSite を使う。
 */
export function canEnterArea(actor: Actor | null | undefined, area: AdminArea): GuardResult {
  if (!actor || actor.status !== 'active' || actor.assignments.length === 0) {
    return { allowed: false, reason: 'unauthenticated' };
  }

  const tenants = accessibleTenants(actor);

  if (area === 'platform') {
    // developer のみ scope:'all'。それ以外は platform エリアに入れない。
    return tenants.scope === 'all'
      ? { allowed: true }
      : { allowed: false, reason: 'forbidden-area' };
  }

  // admin: developer も含め、何らかのテナントにアクセスできれば入口は許可。
  const hasTenantAccess = tenants.scope === 'all' || tenants.tenantIds.length > 0;
  return hasTenantAccess ? { allowed: true } : { allowed: false, reason: 'forbidden-area' };
}

/** GuardResult を boolean に畳む簡便ヘルパ。 */
export function isAreaAllowed(actor: Actor | null | undefined, area: AdminArea): boolean {
  return canEnterArea(actor, area).allowed;
}

/* ===================== per-screen / per-scope ガード (issue #91, increment 1) ===================== */

/**
 * 画面（screen）単位のガードキー。`navigation.ts` のルートとは独立に、表示・操作可否の
 * 判定に使う論理キー。`<エリア>:<画面>` で命名する。**`navigation.ts` は単独編集者が別途
 * 管理するため本書では参照しない**（重複定義回避）。
 *
 * read だけで足りる画面（監査ログ閲覧など）と write を伴う画面（ガバナンス系設定）を区別し、
 * `requiredOp` で「その画面に入るのに最低限必要な操作種別」を表す。
 */
export type AdminScreenKey =
  | 'admin:dashboard'
  | 'admin:security' // ガバナンス（認証・アクセス制御設定）。書き込みを伴う。
  | 'admin:audit'; // 監査ログ閲覧。read のみ。

/** 画面ごとの最小要件。エリアと、入場に必要な操作種別を持つ。 */
type ScreenRequirement = { area: AdminArea; requiredOp: Operation };

const SCREEN_REQUIREMENTS: Record<AdminScreenKey, ScreenRequirement> = {
  'admin:dashboard': { area: 'admin', requiredOp: 'read' },
  'admin:security': { area: 'admin', requiredOp: 'write' },
  'admin:audit': { area: 'admin', requiredOp: 'read' },
};

/** 画面ガードの拒否理由。エリア外・読み取り権限なし・書き込み権限なしを区別する。 */
export type ScreenGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden-area' | 'forbidden-read' | 'forbidden-write';
    };

/**
 * actor が指定画面へ入れるか。
 *   1. まずエリア入場可否（canEnterArea）。
 *   2. 画面が write を要求するなら、actor がどこか 1 つでも書き込み可能ロールを持つこと。
 *      （細粒度のテナント/サイト境界は各操作実行時に canActOn* で別途検証する。ここは入口 UX。）
 *
 * 重要: これは表示制御（UX）に過ぎない。最終的な認可は必ず API 側で行う。
 */
export function canEnterScreen(
  actor: Actor | null | undefined,
  screen: AdminScreenKey,
): ScreenGuardResult {
  const req = SCREEN_REQUIREMENTS[screen];
  const area = canEnterArea(actor, req.area);
  if (!area.allowed) {
    return { allowed: false, reason: area.reason };
  }
  if (req.requiredOp === 'write' && !canWriteAnywhere(actor)) {
    return { allowed: false, reason: 'forbidden-write' };
  }
  return { allowed: true };
}

/** ScreenGuardResult を boolean に畳む簡便ヘルパ。 */
export function isScreenAllowed(
  actor: Actor | null | undefined,
  screen: AdminScreenKey,
): boolean {
  return canEnterScreen(actor, screen).allowed;
}

/**
 * actor がいずれかのテナント/サイトで書き込み可能ロール（developer/tenant_admin/site_manager）を
 * 持つか。**「書き込みボタンを出すか」**の判定に使う粗い UX ヘルパ。実際にどのテナントへ
 * 書けるかは canActOnTenant / canActOnSite で個別判定する。
 */
export function canWriteAnywhere(actor: Actor | null | undefined): boolean {
  if (!actor || actor.status !== 'active') return false;
  return actor.assignments.some(
    (a) => a.role === 'developer' || a.role === 'tenant_admin' || a.role === 'site_manager',
  );
}

/**
 * 指定テナントに対する操作可否（read/write）。#80 の canAccessTenant をそのまま委譲する薄い別名。
 * フロントの操作導線（ボタン活性化・確認フロー表示）の判定に使う。
 */
export function canActOnTenant(
  actor: Actor | null | undefined,
  tenantId: TenantId,
  op: Operation = 'read',
): boolean {
  if (!actor) return false;
  return canAccessTenant(actor, tenantId, op);
}

/**
 * 指定サイトに対する操作可否（read/write）。#80 の canAccessSite をそのまま委譲する薄い別名。
 * site_manager のサイト境界を含む細粒度判定に使う。
 */
export function canActOnSite(
  actor: Actor | null | undefined,
  tenantId: TenantId,
  siteId: SiteId,
  op: Operation = 'read',
): boolean {
  if (!actor) return false;
  return canAccessSite(actor, tenantId, siteId, op);
}
