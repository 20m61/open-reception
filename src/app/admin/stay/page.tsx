import { StayManager } from '@/components/admin/StayManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 在館状況と退館管理 (issue #102)。
 *
 * **テナントは選択中テナント、拠点は `?siteId=` が真実源** (#554)。以前は component 側の
 * `'internal'` / `'default'` 固定で、テナントを切り替えても在館状況が変わらず、しかも
 * `'default'` は**実在しない拠点**だった（実在する既定拠点は `'default-site'`）。在館者は
 * 端末の実拠点で記録されるため、**既定のまま開くと一覧が空になり「誰も居ない」と読めた**。
 * 既定拠点はサーバ解決の値を渡す（ヘッダの対象拠点表示と同じ出所にして、ヘッダと本文が
 * 別の拠点を指す事故を作らない）。
 */
export default async function AdminStayPage() {
  const tenantId = await resolveAdminTenantId();
  return <StayManager tenantId={tenantId} siteId={String(resolveDefaultScope().siteId)} />;
}
