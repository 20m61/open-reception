/**
 * テナント別プロバイダ設定の認可・テナントコンテキスト解決 (issue #405 Inc1)。
 *
 * セキュリティ方針:
 *   - 認可は authorizePlatform（developer 限定）に一点集約する。本 module の
 *     `canManageTenantProviderConfig` はその判定を**将来 tenant_admin 開放できる形**に切り出した
 *     純関数（現状は developer=全テナント横断のみ許可）。
 *   - 対象 tenantId は **クライアント指定を使わず**、認可済みコンテキスト（選択中テナント Cookie を
 *     実在テナントへ解決したもの）から導出する（AC4）。これにより body/query の tenantId で他テナントの
 *     secret 参照名を組み立てられない。
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Actor } from '@/domain/tenant/authorization';
import { accessibleTenants } from '@/domain/tenant/authorization';
import { asTenantId, type TenantId } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { SELECTED_TENANT_COOKIE } from '@/lib/platform/selected-tenant';

/**
 * actor が指定テナントのプロバイダ設定を管理できるか（純粋）。
 * Inc1: developer（accessibleTenants.scope==='all'）のみ true。
 * 将来 tenant_admin 開放時は下記コメントの 1 行を有効化する
 *   （`import { canAccessTenant } ...; return canAccessTenant(actor, tenantId, 'write');`）。
 */
export function canManageTenantProviderConfig(actor: Actor, _tenantId: TenantId): boolean {
  // developer は全テナント横断で管理可。それ以外は Inc1 では不可（越境不可）。
  return accessibleTenants(actor).scope === 'all';
}

/** テナントコンテキスト解決の失敗（そのまま return できる NextResponse を同梱）。 */
type ContextResult =
  | { ok: true; tenantId: TenantId }
  | { ok: false; response: NextResponse };

/**
 * 選択中テナント Cookie を実在テナントへ解決し、管理可否を確認する。tenantId は本経路のみで確定し、
 * リクエスト body/query からは受け取らない（AC4）。
 *   - 未選択            → 400 tenant_required。
 *   - 実在しない tenantId → 404 tenant_not_found（存在秘匿）。
 *   - 管理権限なし        → 403 forbidden。
 */
export async function resolveProviderConfigContext(actor: Actor): Promise<ContextResult> {
  const selected = (await cookies()).get(SELECTED_TENANT_COOKIE)?.value?.trim();
  if (!selected) {
    return { ok: false, response: NextResponse.json({ error: 'tenant_required' }, { status: 400 }) };
  }
  const tenantId = asTenantId(selected);
  const tenant = await getTenantStore().tenants.getTenant(tenantId);
  if (!tenant) {
    return { ok: false, response: NextResponse.json({ error: 'tenant_not_found' }, { status: 404 }) };
  }
  if (!canManageTenantProviderConfig(actor, tenantId)) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, tenantId };
}
