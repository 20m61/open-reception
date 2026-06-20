import { TenantList } from '@/components/admin/platform/TenantList';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: テナント一覧（テナント横断 read） (issue #90, increment 1)。
 * data 取得・認可は /api/platform/tenants（developer 専用 read）。
 */
export default function PlatformTenantsPage() {
  return <TenantList />;
}
