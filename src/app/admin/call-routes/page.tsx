import { CallRoutesManager } from '@/components/admin/CallRoutesManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 呼び出し先・通知ルート管理 (issue #88)。 */
export default function AdminCallRoutesPage() {
  return <CallRoutesManager />;
}
