import { TenantDetail } from '@/components/admin/platform/TenantDetail';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: テナント詳細（テナント横断 read） (issue #90, increment 2)。
 * data 取得・認可は /api/platform/tenants/[tenantId]（developer 専用 read）。
 */
export default async function PlatformTenantDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  return <TenantDetail tenantId={tenantId} />;
}
