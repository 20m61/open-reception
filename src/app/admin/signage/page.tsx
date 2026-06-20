import { SignageManager } from '@/components/admin/SignageManager';

export const dynamic = 'force-dynamic';

/** 管理画面: 待機中サイネージ設定 (issue #101)。 */
export default function AdminSignagePage() {
  return <SignageManager />;
}
