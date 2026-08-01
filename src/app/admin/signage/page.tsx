import { SignageManager } from '@/components/admin/SignageManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 待機中サイネージ設定 (issue #101)。
 *
 * **テナントは選択中テナント、拠点は `?siteId=` が真実源** (#554)。以前は component 側の
 * `'internal'` / `'default'` 固定だった。**実在する既定拠点は `'default-site'`** なので、
 * 管理画面が `'default'` に保存する一方で受付端末は `'default-site'` を読んでおり、
 * **保存したサイネージ設定が端末に反映されない**状態だった。
 * 既定拠点はサーバ解決の値を渡す（ヘッダの対象拠点表示と同じ出所）。
 */
export default async function AdminSignagePage() {
  const tenantId = await resolveAdminTenantId();
  return <SignageManager tenantId={tenantId} siteId={String(resolveDefaultScope().siteId)} />;
}
