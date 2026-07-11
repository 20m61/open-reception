import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { TenantRole } from '@/domain/tenant/types';
import type { Actor } from '@/domain/tenant/authorization';
import { AdminShell } from '@/components/admin/AdminShell';
import { TenantSwitcher } from '@/components/admin/TenantSwitcher';
import { ADMIN_NAV, isActivePath } from '@/components/admin/navigation';
import { resolveAdminActor } from '@/lib/auth/actor';
import { resolveActiveTenant } from '@/lib/tenant/active-tenant';
import { canEnterArea } from '@/domain/auth/route-guard';
import { PATHNAME_HEADER } from '@/proxy';

/**
 * 管理画面レイアウト (issue #22, #24, #85; 実 actor 解決 increment 1)。
 *
 * 管理画面は認証・認可必須。actor（実セッション/Entra クレーム → 境界付き RoleAssignment）を
 * 中央モジュール @/lib/auth/actor で解決し、route guard（canEnterArea）を実適用する。
 *   - 未認証 / 非 active / テナント割り当てなし → /admin/login へリダイレクト。
 * nav の表示は解決済み actor のロールに基づく（暫定の固定ロールは廃止）。
 *
 * 最終的な認可は引き続き各 API / middleware（src/proxy.ts）で行う。本ガードは入口 UX。
 */

/** actor の割り当てから表示ロール（TenantRole[]）を導く（重複除去）。 */
function rolesFromActor(actor: Actor): readonly TenantRole[] {
  return [...new Set(actor.assignments.map((a) => a.role))];
}

/**
 * 管理画面のタブタイトル解決 (issue #331)。
 *
 * `ADMIN_NAV`（IA の単一情報源。表示ラベルはここから借用するだけで編集はしない）を
 * 平坦化し、現在パスに最長一致するナビ項目のラベルをタイトルにする。これにより
 * 個々の page.tsx にタイトルを追加配線せずとも、ナビが増減すれば自動でタブタイトルも
 * 追従する。root layout の `template: '%s | open-reception'` と合わさって
 * 「受付履歴 | open-reception」のように画面ごとに区別できるタイトルになる。
 */
const ADMIN_TITLE_ENTRIES: readonly { href: string; label: string }[] = [
  { href: '/admin/login', label: 'ログイン' },
  ...ADMIN_NAV.flatMap((group) => group.items),
];

/** 現在パスに最も近い（最長一致の）ナビ項目ラベルを解決する。未知のパスは既定文言。 */
export function resolveAdminTitle(pathname: string): string {
  const match = [...ADMIN_TITLE_ENTRIES]
    .sort((a, b) => b.href.length - a.href.length)
    .find((entry) => isActivePath(entry.href, pathname));
  return match?.label ?? '管理画面';
}

export async function generateMetadata(): Promise<Metadata> {
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  return { title: resolveAdminTitle(pathname) };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // ログインページは認証前に表示する必要があるため、ガード・共通シェルを適用しない。
  // （proxy.ts が PATHNAME_HEADER に現在パスを付与する。/admin/login は middleware の公開パス。）
  const pathname = (await headers()).get(PATHNAME_HEADER) ?? '';
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  const actor = await resolveAdminActor();
  if (!actor || !canEnterArea(actor, 'admin').allowed) {
    redirect('/admin/login');
  }

  // 選択中テナントと選択肢を actor 基準で解決する（越境 cookie は採用しない）。
  // 選択は表示用であり、認可は引き続き各 API / service が actor を正として検証する。
  const { options, activeTenantId } = await resolveActiveTenant(actor);

  return (
    <AdminShell
      area="admin"
      title="管理画面"
      nav={ADMIN_NAV}
      roles={rolesFromActor(actor)}
      tenantSwitcher={
        <TenantSwitcher options={options} activeTenantId={activeTenantId ?? undefined} />
      }
    >
      {children}
    </AdminShell>
  );
}
