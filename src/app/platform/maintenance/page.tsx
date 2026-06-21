import { MaintenanceStatus } from '@/components/admin/platform/MaintenanceStatus';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: メンテナンス（read 中心） (issue #90, increment 2)。
 * data 取得・認可は /api/platform/maintenance（developer 専用 read）。
 * 発動などの破壊的操作は確認・影響範囲表示・昇格・監査を伴う導線に隔離する（プレースホルダ）。
 */
export default function PlatformMaintenancePage() {
  return <MaintenanceStatus />;
}
