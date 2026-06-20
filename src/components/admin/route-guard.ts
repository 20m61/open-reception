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
import type { Actor } from '@/domain/tenant/authorization';
import { accessibleTenants } from '@/domain/tenant/authorization';

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
