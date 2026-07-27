import { ExperienceVersionsManager } from '@/components/admin/ExperienceVersionsManager';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 受付体験の版管理と端末への反映状況 (issue #420)。
 *
 * テナント/サイトは既存 admin 慣例（`resolveDefaultScope`、env で上書き可能）で解決する。
 * 下書き保存時の構成解決に使う代表端末はサーバ側（`resolveRepresentativeKioskId`）が拠点の
 * 端末台帳から選ぶ。画面が暫定 ID を持たないようにするため（台帳 §6）。
 *
 * ナビ配線は `src/components/admin/navigation.ts`（#421 の IA 再編で扱う）。
 * このページ自体は直接 URL（/admin/experience-versions）でアクセス可能。
 */
export default function AdminExperienceVersionsPage() {
  const scope = resolveDefaultScope();
  return (
    <ExperienceVersionsManager tenantId={String(scope.tenantId)} siteId={String(scope.siteId)} />
  );
}
