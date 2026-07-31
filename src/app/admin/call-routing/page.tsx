import { RoutingPolicyManager } from '@/components/admin/RoutingPolicyManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 文章形式ルートビルダー（接続先 + 取次ルート） (issue #374)。
 *
 * テナント/サイトは既存 admin 慣例（`resolveDefaultScope`、env で上書き可能）で解決して渡す。
 * これまで `RoutingPolicyManager` 側に 'internal' / 'default-site' をハードコードしていた
 * （第5wave 申し送り nit）のを解消し、単一テナント運用でも env で切り替えられるようにする。
 */
export default async function AdminCallRoutingPage() {
  // 拠点の既定値は resolveDefaultScope のままでよいが、**テナントは選択中テナント**で
  // 解決する (#421)。既定固定だと TenantSwitcher の選択から外れる。
  const scope = resolveDefaultScope();
  const tenantId = await resolveAdminTenantId();
  return <RoutingPolicyManager tenantId={tenantId} siteId={String(scope.siteId)} />;
}
