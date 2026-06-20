import { UsageManager } from '@/components/admin/usage/UsageManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 利用量の可視化 (issue #89, increment 1)。 */
export default function AdminUsagePage() {
  return <UsageManager />;
}
