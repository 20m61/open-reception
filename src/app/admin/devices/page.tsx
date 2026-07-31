import { DevicesManager } from '@/components/admin/DevicesManager';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 受付端末管理 (issue #87, increment 2)。
 *
 * テナントは**選択中テナント**で解決する (#421)。既定テナント固定だと、テナントを
 * 切り替えた developer に別テナントの設定を見せうる（拠点 ID はテナント内スコープ）。
 */
export default async function AdminPage() {
  const tenantId = await resolveAdminTenantId();
  return <DevicesManager tenantId={tenantId} />;
}
