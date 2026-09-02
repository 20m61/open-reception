import { SitesManager } from '@/components/admin/SitesManager';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 拠点管理 (issue #87)。
 *
 * テナントは**選択中テナント**で解決する。ここだけ `internal` 固定だったため、
 * developer がテナント B を選んでいてもこの一覧は `internal` の拠点を出し、そこから
 * 拠点詳細へ入ると「拠点が見つかりません」になっていた（#552 レビュー P2）。
 */
export default async function AdminSitesPage() {
  const tenantId = await resolveAdminTenantId();
  return <SitesManager tenantId={tenantId} />;
}
