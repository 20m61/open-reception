import type { TenantRole } from '@/domain/tenant/types';
import { AdminShell } from '@/components/admin/AdminShell';
import { PLATFORM_NAV } from '@/components/admin/navigation';

/**
 * プラットフォーム運用コンソールのレイアウト雛形 (issue #85, increment 1; 本実装は #90)。
 *
 * 総合開発者・プラットフォーム運用者（developer ロール）専用エリア。
 * 通常時は読み取り中心・対象テナントを常に明示し、破壊的操作は DangerZone へ隔離する。
 *
 * route guard の厳密適用は次増分。actor 解決が入り次第ここで
 * canEnterArea(actor, 'platform')（= developer のみ許可）を適用する想定。
 * 雛形は src/components/admin/route-guard.ts。
 */

// actor 解決が未連携のため developer 相当の表示ロールを暫定で用いる（次増分で実 actor に差し替え）。
const PROVISIONAL_ROLES: readonly TenantRole[] = ['developer'];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminShell
      area="platform"
      title="運用コンソール"
      nav={PLATFORM_NAV}
      roles={PROVISIONAL_ROLES}
      tenantLabel="全テナント横断"
    >
      {children}
    </AdminShell>
  );
}
