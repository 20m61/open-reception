/**
 * 実 actor 解決の中央モジュール (issue #80, #85; 実 actor 解決 increment 1)。
 *
 * 目的:
 *   - これまで各 admin route が使っていた暫定 `resolveAdminActor`（管理セッションが
 *     有効なら常に developer 相当を返す）を廃し、実セッション / Entra クレームから
 *     実 `Actor`（テナント/サイト境界付き RoleAssignment）を解決する。
 *
 * 2 ロール体系の関係（詳細は docs/admin-actor-resolution-design.md）:
 *   - src/domain/auth/roles.ts: Entra App Role claim → AdminRole（'Admin'|'SiteManager'|'Viewer'）。
 *   - src/domain/tenant/{types,authorization}.ts: TenantRole と RoleAssignment による境界認可。
 *   本モジュールは前者から後者へ写像し、env 由来のテナント/サイト境界を束ねて Actor を作る。
 *
 * セキュリティ方針:
 *   - developer（全テナント横断）は env の明示 allowlist でのみ付与する。Entra / password
 *     セッションからは自動付与しない（最小権限）。
 *   - Entra トークンは未検証のまま信頼しない。本モジュールの非純粋ラッパは middleware
 *     (src/proxy.ts) と同じ verifyEntraToken（JWKS 署名 / issuer / audience / exp）を通す。
 *   - 写像・境界構築は純関数として分離し、テストで網羅する（非純粋部は薄く保つ）。
 */
import { cookies } from 'next/headers';
import { resolveAdminRole, type AdminRole } from '@/domain/auth/roles';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asSiteId,
  asTenantId,
  type AdminUser,
  type RoleAssignment,
  type TenantRole,
} from '@/domain/tenant/types';
import { getAdminUserRepository } from '@/lib/tenant/admin-user-store';
import { ADMIN_COOKIE, ENTRA_TOKEN_COOKIE, getAdminSecret } from '@/lib/auth/admin';
import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { createJwksResolver, verifyEntraToken, type EntraClaims } from '@/lib/auth/entra';
import { verifySession } from '@/lib/auth/session';

/* ===================== 純関数（テスト対象） ===================== */

/**
 * actor 解決のためのテナント/サイト境界設定。env から読み出す（buildActorConfig 参照）。
 */
export type ActorConfig = {
  /** 既定テナント ID（env 未指定なら 'default'）。 */
  defaultTenantId: string;
  /** 既定サイト ID（任意）。site_manager の siteId 確定に使う。 */
  defaultSiteId?: string;
  /** password セッションに与える TenantRole（既定 'tenant_admin'）。 */
  passwordRole: TenantRole;
  /** developer を付与するメール allowlist（小文字化済み集合）。空なら誰にも付与しない。 */
  developerEmails: Set<string>;
  /**
   * AdminUser ストアに登録の無い Entra ユーザーの扱い（最小権限が既定）:
   *   - 'deny'（既定）: 割り当てを解決できないため拒否（Actor=null）。真のテナント分離。
   *   - 'env_roles':    従来どおり env 既定テナント境界 + Entra roles claim から Actor を作る
   *                     （後方互換。単一テナント運用や移行期向け）。
   */
  entraUnregistered: 'deny' | 'env_roles';
};

/**
 * AdminRole → TenantRole の写像。
 *   Admin → tenant_admin / SiteManager → site_manager / Viewer → viewer。
 * developer は Entra/password からは自動付与しない（allowlist 経由のみ）。
 */
export function adminRoleToTenantRole(role: AdminRole): TenantRole {
  switch (role) {
    case 'Admin':
      return 'tenant_admin';
    case 'SiteManager':
      return 'site_manager';
    case 'Viewer':
      return 'viewer';
  }
}

/** TenantRole に siteId 束縛が必須か（site_manager のみ）。 */
function requiresSite(role: TenantRole): boolean {
  return role === 'site_manager';
}

/**
 * 解決済み TenantRole と境界設定から 1 件の RoleAssignment を組み立てる。
 * - tenantId は常に必須（developer を除く）。
 * - site_manager は siteId 必須。claim の siteId（任意）を優先し、無ければ config.defaultSiteId。
 *   どちらも無ければ siteId を確定できないため null を返す（呼び出し側で除外）。
 */
export function buildAssignment(
  role: TenantRole,
  config: ActorConfig,
  claimSiteId?: string,
): RoleAssignment | null {
  const tenantId = asTenantId(config.defaultTenantId);
  if (requiresSite(role)) {
    const siteRaw = claimSiteId ?? config.defaultSiteId;
    if (!siteRaw) return null; // siteId を確定できない site_manager は付与しない。
    return { role, tenantId, siteId: asSiteId(siteRaw), deviceId: null };
  }
  return { role, tenantId, siteId: null, deviceId: null };
}

/**
 * email が developer allowlist に含まれるか（大文字小文字無視）。
 */
function isDeveloperEmail(email: string | undefined, config: ActorConfig): boolean {
  if (!email) return false;
  return config.developerEmails.has(email.trim().toLowerCase());
}

/**
 * Entra の roles claim + claims から Actor を構築する。
 *   - roles claim から AdminRole を解決 → TenantRole へ写像 → 境界付き RoleAssignment。
 *   - email が developer allowlist にあれば developer 割り当てを追加（全テナント横断）。
 *   - 解決できる割り当てが 1 件も無ければ null（route 側で 401/403）。
 */
export function buildActorFromEntraRoles(
  rolesClaim: unknown,
  config: ActorConfig,
  claims?: Pick<EntraClaims, 'email' | 'preferred_username'>,
): Actor | null {
  const assignments: RoleAssignment[] = [];

  const adminRole = resolveAdminRole(rolesClaim);
  if (adminRole) {
    const tenantRole = adminRoleToTenantRole(adminRole);
    const assignment = buildAssignment(tenantRole, config);
    if (assignment) assignments.push(assignment);
  }

  const email = claims?.email ?? claims?.preferred_username;
  if (isDeveloperEmail(email, config)) {
    assignments.push({ role: 'developer', tenantId: null, siteId: null, deviceId: null });
  }

  if (assignments.length === 0) return null;
  return { status: 'active', assignments };
}

/**
 * 永続化された AdminUser から Actor を構築する（実データによるテナント境界の解決）。
 *   - AdminUser.assignments をそのまま正とする（env 既定テナントへ束ねない）。
 *   - status!=='active'（suspended）は拒否=null。
 *   - developer は AdminUser に明示割り当てがある場合に加え、email が allowlist にある
 *     場合も付与する（buildActorFromEntraRoles と一貫した最小権限ポリシー）。
 *   - 有効な割り当てが 1 件も無ければ null。
 *
 * 純関数（I/O は呼び出し側の resolveActorFromStore が担う）。
 */
export function buildActorFromAdminUser(
  user: Pick<AdminUser, 'assignments' | 'status' | 'email'>,
  config: ActorConfig,
): Actor | null {
  if (user.status !== 'active') return null;
  const assignments: RoleAssignment[] = [...user.assignments];

  const hasDeveloper = assignments.some((a) => a.role === 'developer');
  if (!hasDeveloper && isDeveloperEmail(user.email, config)) {
    assignments.push({ role: 'developer', tenantId: null, siteId: null, deviceId: null });
  }

  if (assignments.length === 0) return null;
  return { status: 'active', assignments };
}

/**
 * password セッション（共有パスワード）から Actor を構築する。
 *   - 既定で config.passwordRole（既定 tenant_admin）を 1 件付与する。
 *   - developer を許すのは OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer の明示時のみ。
 *   - email を持たないため developer allowlist は適用できない（passwordRole で制御）。
 */
export function buildActorFromPasswordSession(config: ActorConfig): Actor | null {
  if (config.passwordRole === 'developer') {
    return {
      status: 'active',
      assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
    };
  }
  const assignment = buildAssignment(config.passwordRole, config);
  if (!assignment) return null;
  return { status: 'active', assignments: [assignment] };
}

/** カンマ区切りの email を小文字 Set へ。 */
function parseEmails(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const e = part.trim().toLowerCase();
    if (e) out.add(e);
  }
  return out;
}

const VALID_TENANT_ROLES: ReadonlySet<string> = new Set([
  'developer',
  'tenant_admin',
  'site_manager',
  'viewer',
]);

/** env からテナント/サイト境界設定を組み立てる（純関数: env を引数で受ける）。 */
export function buildActorConfig(env: Record<string, string | undefined> = process.env): ActorConfig {
  const rawPasswordRole = env.OPEN_RECEPTION_ADMIN_PASSWORD_ROLE;
  // 未知/不正な値は安全側の既定（tenant_admin）に倒す。developer は明示時のみ。
  const passwordRole: TenantRole =
    rawPasswordRole && VALID_TENANT_ROLES.has(rawPasswordRole)
      ? (rawPasswordRole as TenantRole)
      : 'tenant_admin';
  // 未登録 Entra ユーザーの扱い。既定は最小権限（拒否）。明示時のみ env roles フォールバック。
  const entraUnregistered =
    env.OPEN_RECEPTION_ENTRA_UNREGISTERED === 'env_roles' ? 'env_roles' : 'deny';
  return {
    // 既定はプロビジョニング済みテナント（lib/tenant/store.ts の seed）に一致させる。
    // ここが 'default' だと password 管理セッションが 'internal' テナントの admin データを
    // 一切操作できず、admin 画面が機能しない（#171）。env で上書き可能。
    defaultTenantId: env.OPEN_RECEPTION_DEFAULT_TENANT_ID ?? 'internal',
    defaultSiteId: env.OPEN_RECEPTION_DEFAULT_SITE_ID ?? 'default-site',
    passwordRole,
    developerEmails: parseEmails(env.OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS),
    entraUnregistered,
  };
}

/* ===================== 非純粋ラッパ（薄く保つ） ===================== */

/**
 * 管理セッションが有効かを判定する（旧 reservation/request.ts より移設）。
 * password / entra いずれの cookie でも、署名・期限が有効なら true。
 * 注: Entra トークンの厳密検証は resolveAdminActor 側で行う。本関数は「入口」判定。
 */
export async function hasValidAdminSession(): Promise<boolean> {
  const jar = await cookies();
  const admin = await verifySession(jar.get(ADMIN_COOKIE)?.value, getAdminSecret());
  if (admin && admin.role === 'admin') return true;
  return Boolean(jar.get(ENTRA_TOKEN_COOKIE)?.value);
}

/**
 * Entra ユーザーを AdminUser ストアから解決し、実 assignments で Actor を組み立てる
 * （キーストン: 実データによるテナント分離）。
 *   1. subject（oid/sub）で AdminUser を引く（正キー）。無ければ email で補助解決。
 *   2. 見つかれば buildActorFromAdminUser（実 assignments + developer allowlist）。
 *   3. 未登録なら config.entraUnregistered に従う:
 *        - 'deny'（既定）: null を返す（最小権限 / 真のテナント分離）。
 *        - 'env_roles':    buildActorFromEntraRoles（env 既定境界 + roles claim）で後方互換。
 *
 * 非純粋ラッパ（ストア I/O は getAdminUserRepository が担い、判定は純関数に委譲）。
 */
export async function resolveActorFromStore(
  identity: { subject: string; email?: string; rolesClaim?: unknown },
  config: ActorConfig,
  repo = getAdminUserRepository(),
): Promise<Actor | null> {
  let user = identity.subject ? await repo.findBySubject(identity.subject) : undefined;
  if (!user && identity.email) user = await repo.findByEmail(identity.email);

  if (user) return buildActorFromAdminUser(user, config);

  // 未登録ユーザー: 既定は最小権限で拒否。明示設定時のみ env roles フォールバック。
  if (config.entraUnregistered === 'env_roles') {
    return buildActorFromEntraRoles(identity.rolesClaim, config, { email: identity.email });
  }
  return null;
}

/**
 * 認可主体（Actor）を実セッション / Entra クレームから解決する。
 *   1. password セッション（verifySession で role==='admin'）→ buildActorFromPasswordSession。
 *   2. Entra トークン cookie があれば verifyEntraToken（JWKS 署名検証）を通し、検証済み
 *      subject/email で AdminUser ストアの実 assignments を解決（resolveActorFromStore）。
 *      未登録は config.entraUnregistered（既定 deny）に従う。
 *   いずれも無効なら null（route 側で 401）。
 *
 * Entra と password の両方が存在する場合は password を優先する（明示ログイン）。
 */
export async function resolveAdminActor(): Promise<Actor | null> {
  const jar = await cookies();
  const config = buildActorConfig();

  // 1. password セッション。
  const admin = await verifySession(jar.get(ADMIN_COOKIE)?.value, getAdminSecret());
  if (admin && admin.role === 'admin') {
    return buildActorFromPasswordSession(config);
  }

  // 2. Entra トークン。署名・issuer・audience・exp を検証してから信頼する。
  const token = jar.get(ENTRA_TOKEN_COOKIE)?.value;
  if (!token) return null;

  const cfg = getAdminAuthConfig();
  if (cfg.provider !== 'entra' || !cfg.entra) return null;

  const result = await verifyEntraToken(token, {
    issuer: cfg.entra.issuer,
    audience: cfg.entra.audience,
    allowedRoles: cfg.entra.allowedRoles,
    getKey: createJwksResolver(cfg.entra.jwksUri),
  });
  if (!result.ok) return null;

  // 検証済み subject/email で実 AdminUser を解決する（env 既定テナントへ束ねない）。
  return resolveActorFromStore(
    { subject: result.subject, email: result.email, rolesClaim: result.claims.roles },
    config,
  );
}
