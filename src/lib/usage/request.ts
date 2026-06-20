/**
 * 利用量・コスト read API の共通リクエスト解釈 (issue #89, increment 1)。
 *
 * 認証: resolveAdminActor で実 actor を解決（無効なら 401）。
 * 認可: #80 の canAccessTenant 純関数で tenantId 境界を判定（他テナント参照は 403）。
 *   developer は横断閲覧可。対象テナントの明示は呼び出し側 UI が行う（#89 受け入れ条件）。
 *
 * 本モジュールは read 専用。書き込みは行わない。
 */
import { NextResponse } from 'next/server';
import type { Actor } from '@/domain/tenant/authorization';
import { canAccessTenant } from '@/domain/tenant/authorization';
import { asTenantId, type TenantId } from '@/domain/tenant/types';
import { resolveAdminActor } from '@/lib/auth/actor';

export type ScopeResult =
  | { ok: true; actor: Actor; tenantId: TenantId }
  | { ok: false; response: NextResponse };

/**
 * 利用量/コスト read API のアクセス制御を一括で行う。
 *   1. actor 解決（401）。
 *   2. tenantId 抽出（必須。無ければ 400）。
 *   3. canAccessTenant（read）でテナント境界判定（403）。
 *
 * これにより他テナントの利用量・コストが返らないことを保証する。
 */
export async function resolveUsageScope(searchParams: URLSearchParams): Promise<ScopeResult> {
  const actor = await resolveAdminActor();
  if (!actor) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const raw = searchParams.get('tenantId');
  if (!raw) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid_input', message: 'tenantId is required' }, { status: 400 }),
    };
  }
  const tenantId = asTenantId(raw);
  if (!canAccessTenant(actor, tenantId, 'read')) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, actor, tenantId };
}
