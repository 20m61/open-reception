import { PlatformDashboard } from '@/components/admin/platform/PlatformDashboard';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム運用コンソールのダッシュボード (issue #90, increment 1)。
 *
 * 全テナントの稼働概況（テナント数/稼働/停止）を表示し、実データ未接続の運用指標は
 * 「未接続」と明示する。data 取得・認可は /api/platform/dashboard（developer 専用 read）。
 * エリアガードは layout.tsx（canEnterArea, developer のみ）。
 */
export default function PlatformDashboardPage() {
  return <PlatformDashboard />;
}
