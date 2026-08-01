import { ExperienceVersionsManager } from '@/components/admin/ExperienceVersionsManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 受付体験の版管理と端末への反映状況 (issue #420)。
 *
 * **テナントは選択中テナント**で解決する (#554)。既定テナント固定だと、テナントを切り替えた
 * developer に別テナントの版を見せ、しかも操作させてしまう（版は拠点内スコープ）。
 * 拠点は `?siteId=` が真実源で、既定拠点はサーバ解決の値を渡す（ヘッダの対象拠点表示と同じ出所）。
 * 下書き保存時の構成解決に使う代表端末はサーバ側（`resolveRepresentativeKioskId`）が拠点の
 * 端末台帳から選ぶ。画面が暫定 ID を持たないようにするため（台帳 §6）。
 *
 * ナビ配線は `src/components/admin/navigation.ts`（#421 の IA 再編で扱う）。
 * このページ自体は直接 URL（/admin/experience-versions）でアクセス可能。
 */
export default async function AdminExperienceVersionsPage() {
  const tenantId = await resolveAdminTenantId();
  return (
    <ExperienceVersionsManager
      tenantId={tenantId}
      siteId={String(resolveDefaultScope().siteId)}
    />
  );
}
