import { FeatureFlags } from '@/components/admin/platform/FeatureFlags';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: 機能フラグ / 利用制限 (issue #90 inc2 / #83 inc5a)。
 * read は /api/platform/feature-flags と /api/platform/tenants/[tenantId]/feature-flags
 * （developer 専用）。テナント別フラグの変更は同ルートへの PATCH（JIT 昇格必須・理由つき監査）。
 * 利用上限の変更はメータリング (#89) 接続後の増分（プレースホルダ）。
 */
export default function PlatformFeatureFlagsPage() {
  return <FeatureFlags />;
}
