import { UpdateStatus } from '@/components/admin/platform/UpdateStatus';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: アップデート状況（read 中心） (issue #83 AC6)。
 * data 取得・認可は /api/platform/updates（developer 専用 read）。
 * 更新の実行・ロールバックは確認・影響範囲表示・昇格・監査を伴う導線に隔離する（プレースホルダ）。
 */
export default function PlatformUpdatesPage() {
  return <UpdateStatus />;
}
