import { redirect } from 'next/navigation';
import { AdminShell } from '@/components/admin/AdminShell';
import { PLATFORM_NAV } from '@/components/admin/navigation';
import { resolveAdminActor } from '@/lib/auth/actor';
import { canEnterArea } from '@/components/admin/route-guard';

/**
 * プラットフォーム運用コンソールのレイアウト (issue #85; 実 actor 解決 increment 1)。
 *
 * 総合開発者・プラットフォーム運用者（developer ロール）専用エリア。
 * 実 actor を @/lib/auth/actor で解決し、canEnterArea(actor, 'platform')（developer のみ許可）を
 * 実適用する。
 *   - 未認証              → /admin/login。
 *   - 認証済みだが非developer → /admin（権限不足。テナント管理者は admin へ）。
 *
 * developer は env の明示 allowlist（OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS）または
 * OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer でのみ付与される（最小権限）。
 * 最終的な認可は引き続き各 API / middleware（src/proxy.ts）で行う。
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await resolveAdminActor();
  if (!actor) redirect('/admin/login');
  if (!canEnterArea(actor, 'platform').allowed) redirect('/admin');

  return (
    <AdminShell
      area="platform"
      title="運用コンソール"
      nav={PLATFORM_NAV}
      roles={['developer']}
      tenantLabel="全テナント横断"
    >
      {children}
    </AdminShell>
  );
}
