import { SecurityManager } from '@/components/admin/SecurityManager';

export const dynamic = 'force-dynamic';

/** 管理画面: セキュリティ設定 (issue #23, #29)。 */
export default function AdminSecurityPage() {
  return <SecurityManager />;
}
