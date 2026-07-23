import { RoutingPolicyManager } from '@/components/admin/RoutingPolicyManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 文章形式ルートビルダー（接続先 + 取次ルート） (issue #374)。
 *
 * テナント/サイトは既存 admin 慣例（`resolveDefaultScope`、env で上書き可能）で解決して渡す。
 * これまで `RoutingPolicyManager` 側に 'internal' / 'default-site' をハードコードしていた
 * （第5wave 申し送り nit）のを解消し、単一テナント運用でも env で切り替えられるようにする。
 */
export default function AdminCallRoutingPage() {
  const scope = resolveDefaultScope();
  return <RoutingPolicyManager tenantId={String(scope.tenantId)} siteId={String(scope.siteId)} />;
}
