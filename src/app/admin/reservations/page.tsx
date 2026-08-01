import { ReservationsManager } from '@/components/admin/ReservationsManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 来訪予約と QR 発行 (issue #97)。
 *
 * **テナントは選択中テナント、拠点は `?siteId=` が真実源** (#554)。以前は component 側の
 * `'internal'` / `'default'` 固定で、**実在する既定拠点は `'default-site'`** なので
 * 画面を開いただけで実在しない拠点の予約を読み書きしていた。既定拠点はサーバ解決の値を
 * 渡す（ヘッダの対象拠点表示と同じ出所）。
 */
export default async function AdminReservationsPage() {
  const tenantId = await resolveAdminTenantId();
  return <ReservationsManager tenantId={tenantId} siteId={String(resolveDefaultScope().siteId)} />;
}
