/**
 * 外部連携 / シークレット状態 API の認可ヘルパ (issue #93, increment 1)。
 *
 * 認可方針（#80 純関数へ委譲）:
 *   - 読み取り: 当該テナントへの read 権（viewer 以上）。
 *   - 書き込み（状態更新・接続テスト・secret 状態変更）: 当該テナントの write 権
 *     （tenant_admin 以上）。viewer は実行不可。
 *   - クライアントが送る tenantId はそのまま信用せず、actor の割り当てで検証する。
 *
 * secret/private key の値は本層でも一切扱わない（状態のみ）。
 */
import { NextResponse } from 'next/server';
import { canAccessTenant } from '@/domain/tenant/authorization';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type TenantId } from '@/domain/tenant/types';
import { resolveAdminActor } from '@/lib/auth/actor';

export type Authorized = { actor: Actor; tenantId: TenantId };
export type AuthzError = NextResponse;

/** tenantId をクエリ or ボディから取り出す（必須）。 */
function readTenantId(source: URLSearchParams | Record<string, unknown>): string | undefined {
  if (source instanceof URLSearchParams) return source.get('tenantId') ?? undefined;
  return typeof source.tenantId === 'string' ? source.tenantId : undefined;
}

/**
 * actor を解決し、tenantId 境界に対する op（read/write）の認可を確認する。
 * 成否を判別可能なユニオンで返す（呼び出し側で early-return する）。
 */
export async function authorize(
  source: URLSearchParams | Record<string, unknown>,
  op: 'read' | 'write',
): Promise<{ ok: true; auth: Authorized } | { ok: false; response: AuthzError }> {
  const actor = await resolveAdminActor();
  if (!actor) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const raw = readTenantId(source);
  if (!raw) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'invalid_input', message: 'tenantId is required' },
        { status: 400 },
      ),
    };
  }
  const tenantId = asTenantId(raw);
  if (!canAccessTenant(actor, tenantId, op)) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, auth: { actor, tenantId } };
}

/**
 * 監査・状態に残す actor ラベル。PII（メール等）は使わず、ロールで表す。
 * developer > tenant_admin > site_manager > viewer の順で最初に該当したロールを返す。
 */
export function actorLabel(actor: Actor): string {
  const order = ['developer', 'tenant_admin', 'site_manager', 'viewer'] as const;
  for (const role of order) {
    if (actor.assignments.some((a) => a.role === role)) return role;
  }
  return 'admin';
}
