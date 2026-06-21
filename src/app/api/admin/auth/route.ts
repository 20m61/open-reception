import { NextResponse } from 'next/server';
import { describeAdminAuthStatus } from '@/lib/auth/admin-auth-config';
import { resolveAdminActor } from '@/lib/auth/actor';
import type { Actor } from '@/domain/tenant/authorization';

/**
 * GET /api/admin/auth — 管理画面の認証方式（provider 切替）と Entra 必須設定の
 * **状態**を返す (issue #70)。
 *
 * セキュリティ最優先:
 *   - Client Secret / アクセストークン / issuer・clientId 等の**値は一切返さない**。
 *     返すのは provider・required・設定の有無（set/missing）・許可ロール・設定エラー要約のみ。
 *   - 認証必須（actor 解決不可なら 401）。
 *   - 認可: 認証設定は env レベル（テナント横断）の運用情報のため、書き込み可能な管理
 *     ロール（tenant_admin / developer 等）を持つ actor のみ閲覧可（viewer は 403）。
 *
 * #93（/admin/integrations）との役割分担:
 *   - #93 はログイン方式の有効/無効を含む横断的な「認証・外部連携・secret」一覧。
 *   - 本 API/画面は Entra に特化した詳細（issuer/audience/jwksUri/clientId/allowedRoles の
 *     個別状態と有効化手順導線）を担う。重複定義はせず、同じ admin-auth-config を参照する。
 */

/** 認証設定を閲覧できる管理ロールを持つか（書き込み可能ロール= tenant_admin 以上）。 */
function canManageAuthConfig(actor: Actor): boolean {
  if (actor.status !== 'active') return false;
  return actor.assignments.some(
    (a) => a.role === 'developer' || a.role === 'tenant_admin' || a.role === 'site_manager',
  );
}

export async function GET(): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!canManageAuthConfig(actor)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json(describeAdminAuthStatus());
}
