import { StaffResponseManager } from '@/components/admin/StaffResponseManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 担当者応答アクション設定（有効/無効・来訪者文言上書き）(issue #99 inc2)。
 *
 * **テナントは選択中テナント、拠点は `?siteId=` が真実源** (#554)。以前は component 側の
 * `'internal'` / `'default-site'` 固定で、既定値自体は正しかったものの**拠点を切り替える
 * 手段が無く**、テナントを切り替えても同じ設定を編集していた。既定拠点はサーバ解決の値を
 * 渡す（ヘッダの対象拠点表示と同じ出所）。
 */
export default async function AdminStaffResponsePage() {
  const tenantId = await resolveAdminTenantId();
  return <StaffResponseManager tenantId={tenantId} siteId={String(resolveDefaultScope().siteId)} />;
}
