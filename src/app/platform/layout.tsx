import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { AdminShell } from '@/components/admin/AdminShell';
import { ElevationStatus } from '@/components/admin/platform/ElevationStatus';
import { TenantSwitcher } from '@/components/admin/platform/TenantSwitcher';
import { PLATFORM_NAV } from '@/components/admin/navigation';
import { resolveAdminActorWithIdentity } from '@/lib/auth/actor';
import { canEnterArea } from '@/domain/auth/route-guard';
import type { ElevationView } from '@/lib/platform/client-elevation';
import { ELEVATION_COOKIE, readElevation } from '@/lib/platform/elevation';
import { elevationJtiState } from '@/lib/platform/elevation-jti-store';

/**
 * SSR 用: 現在の昇格状態を表示用スナップショットとして読む (issue #83 §2 / inc4d)。
 *
 * `assertElevated`（write の強制ゲート）と同じ条件 — 署名/期限 + sub 束縛 + jti 未失効 — を
 * 満たすときだけ「昇格中」を返す。**判定の本体はサーバの write ゲートであり、これは表示専用**。
 * クライアントへは until/scope/reason のみ渡す（cookie 平文・sub・jti は渡さない）。
 * 失敗（secret 未設定の fail-closed throw・store 障害等）は「非昇格」表示に落とし、
 * read 中心の platform コンソール自体は壊さない（表示が保守的に倒れるだけで保護は劣化しない）。
 */
async function readElevationView(identity: string): Promise<ElevationView | null> {
  try {
    const token = (await cookies()).get(ELEVATION_COOKIE)?.value;
    const elevation = await readElevation(token);
    if (!elevation || elevation.sub !== identity) return null;
    if ((await elevationJtiState(elevation.jti, Date.now())) !== 'active') return null;
    return {
      until: elevation.until,
      scope: elevation.scope,
      reason: elevation.reason,
      // break-glass 区分 (#83 §3)。UI が緊急昇格中の警告表示（高重要度監査・利用後レビュー）を出す。
      breakGlass: elevation.breakGlass === true,
    };
  } catch {
    return null;
  }
}

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
 *
 * JIT 昇格の状態（#83 §2 / inc4d）は全 platform ページ共通で本文先頭に常時明示する
 * （ElevationStatus。昇格の開始/終了 UI を含む）。
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const resolved = await resolveAdminActorWithIdentity();
  if (!resolved) redirect('/admin/login');
  if (!canEnterArea(resolved.actor, 'platform').allowed) redirect('/admin');

  const elevation = await readElevationView(resolved.identity);

  return (
    <AdminShell
      area="platform"
      title="運用コンソール"
      nav={PLATFORM_NAV}
      roles={['developer']}
      tenantLabel="全テナント横断"
      tenantSwitcher={<TenantSwitcher />}
    >
      <ElevationStatus initial={elevation} />
      {children}
    </AdminShell>
  );
}
