import { CallRoutesManager } from '@/components/admin/CallRoutesManager';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 呼び出し先・通知ルート管理 (issue #88)。
 *
 * テナントは**選択中テナント**で解決する (#421)。既定テナント固定だと、テナントを
 * 切り替えた developer に別テナントの設定を見せうる（拠点 ID はテナント内スコープ）。
 */
export default async function AdminPage() {
  const tenantId = await resolveAdminTenantId();
  return <CallRoutesManager tenantId={tenantId} />;
}
