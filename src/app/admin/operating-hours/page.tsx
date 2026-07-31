import { OperatingHoursManager } from '@/components/admin/OperatingHoursManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 営業時間設定 (issue #367)。
 * テナント/サイトは既存 admin 慣例（`resolveDefaultScope`、env で上書き可能。
 * `src/app/admin/call-routing/page.tsx` と同方針）で解決して渡す。
 *
 * ナビ配線: `src/components/admin/navigation.ts`（他トラック占有・オーケストレータが後で配線）。
 * このページ自体は直接 URL（/admin/operating-hours）でアクセス可能。
 */
export default async function AdminOperatingHoursPage() {
  // 拠点の既定値は resolveDefaultScope のままでよいが、**テナントは選択中テナント**で
  // 解決する (#421)。既定固定だと TenantSwitcher の選択から外れる。
  const scope = resolveDefaultScope();
  const tenantId = await resolveAdminTenantId();
  return <OperatingHoursManager tenantId={tenantId} siteId={String(scope.siteId)} />;
}
