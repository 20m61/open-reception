import { RoutingPolicyManager } from '@/components/admin/RoutingPolicyManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 文章形式ルートビルダー（接続先 + 取次ルート） (issue #374)。 */
export default function AdminCallRoutingPage() {
  return <RoutingPolicyManager />;
}
