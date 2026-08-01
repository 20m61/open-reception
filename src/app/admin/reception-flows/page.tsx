import { ReceptionFlowsManager } from '@/components/admin/ReceptionFlowsManager';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 来訪目的別カスタム受付フロー管理 (issue #100)。
 *
 * テナントは**選択中テナント**で解決する (#421)。既定テナント固定だと、テナントを
 * 切り替えた developer に別テナントの設定を見せうる（拠点 ID はテナント内スコープ）。
 */
export default async function AdminPage() {
  // 既定拠点は **ヘッダの対象拠点表示と同じ出所**（`resolveDefaultScope`）から渡す (#423)。
  // ここを component 側のハードコード既定に任せると、`OPEN_RECEPTION_DEFAULT_SITE_ID` を
  // 上書きした環境で**ヘッダは env の拠点・本文は 'default-site'** を指す（#552 レビュー P2）。
  const tenantId = await resolveAdminTenantId();
  return <ReceptionFlowsManager tenantId={tenantId} siteId={String(resolveDefaultScope().siteId)} />;
}
