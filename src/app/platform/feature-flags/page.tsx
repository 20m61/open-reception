import { FeatureFlags } from '@/components/admin/platform/FeatureFlags';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: 機能フラグ / 利用制限（read 中心） (issue #90, increment 2)。
 * data 取得・認可は /api/platform/feature-flags（developer 専用 read）。
 * 変更は破壊的操作のため確認・昇格・監査を伴う導線に隔離する（プレースホルダ）。
 */
export default function PlatformFeatureFlagsPage() {
  return <FeatureFlags />;
}
