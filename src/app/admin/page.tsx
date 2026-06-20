import { Dashboard } from '@/components/admin/dashboard/Dashboard';

export const dynamic = 'force-dynamic';

/**
 * 管理ダッシュボード (issue #86, increment 1)。
 * 受付の概況（本日の受付状況・端末稼働・直近の呼び出し）と各管理画面への導線を表示する。
 * 概況は集約 API（/api/admin/dashboard）から取得する。
 */
export default function AdminHomePage() {
  return <Dashboard />;
}
