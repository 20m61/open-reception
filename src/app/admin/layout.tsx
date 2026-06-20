import type { TenantRole } from '@/domain/tenant/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { ADMIN_NAV } from '@/components/admin/navigation';

/**
 * 管理画面レイアウト (issue #22, #24, #85)。
 *
 * 管理画面は認証・認可必須。actor（セッション→AdminUser）の解決と route guard の
 * 厳密適用は次増分（session.ts は現状 role:'admin' のみで RoleAssignment 未連携）。
 * increment 1 では IA 反映の共通シェル（責務グループ別ナビ・現在地表示）に差し替えるに留め、
 * 既存ルート・既存ページは非破壊で維持する。
 *
 * route guard の雛形と適用方針は src/components/admin/route-guard.ts（canEnterArea）。
 * actor 解決が入り次第、ここで canEnterArea(actor, 'admin') を適用する想定。
 */

// actor 解決が未連携のため、テナント管理者相当の表示ロールを暫定で用いる
// （既存の「全項目表示」を IA 上で再現する。次増分で実 actor のロールに差し替え）。
const PROVISIONAL_ROLES: readonly TenantRole[] = ['tenant_admin'];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminShell area="admin" title="管理画面" nav={ADMIN_NAV} roles={PROVISIONAL_ROLES}>
      {children}
    </AdminShell>
  );
}
