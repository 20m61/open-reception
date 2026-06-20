'use server';

/**
 * テナント選択の server action (issue #80, increment 3)。
 *
 * TenantSwitcher（client）からの選択を受け、サーバ側で actor を正として越境検証してから
 * cookie に保存する。クライアントが送る tenantId はそのまま信用しない（#80 §認可）。
 *
 * セキュリティ:
 *   - actor を resolveAdminActor() でサーバ側に解決し直し、canSelectTenant で越境を拒否する。
 *     越境要求（権限外テナント）は cookie を書き換えず黙って無視する（情報を与えない）。
 *   - cookie は HttpOnly・SameSite=Lax・Secure（本番）。選択は表示用であり認可ではない。
 */
import { cookies } from 'next/headers';
import { asTenantId } from '@/domain/tenant/types';
import { resolveAdminActor } from '@/lib/auth/actor';
import { ACTIVE_TENANT_COOKIE } from './active-tenant';
import { canSelectTenant } from './tenant-selection';

/** 選択中テナントを cookie に保存する。越境・未認証は無視する。 */
export async function selectTenant(tenantId: string): Promise<void> {
  const actor = await resolveAdminActor();
  if (!actor) return;
  const id = asTenantId(tenantId.trim());
  if (!id) return;
  // 越境拒否: actor がアクセスできないテナントは採用しない。
  if (!canSelectTenant(actor, id)) return;

  const jar = await cookies();
  jar.set(ACTIVE_TENANT_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
