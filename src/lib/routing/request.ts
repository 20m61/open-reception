/**
 * ルーティング管理 API のリクエスト解釈ヘルパ (issue #374, 残 increment)。
 *
 * - actor の実解決は中央モジュール @/lib/auth/actor（resolveAdminActor）を re-export する。
 * - tenantId（必須）・siteId（任意）の取り出しと ServiceResult → HTTP 変換。
 * 認可そのものは #80 純関数（canAccessSite / canAccessTenant）へ委譲する（service 層で適用）。
 *
 * ポリシー構造検証エラーは 400 で `issues` を同梱し、UI がフィールド別（step 別）に表示できるようにする
 * （アドレス等の機微値は issues に含まれない）。
 */
import { NextResponse } from 'next/server';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { ServiceResult } from './service';

export { resolveAdminActor } from '@/lib/auth/actor';

export type ScopeError = { code: 'invalid_input'; message: string };

/** tenantId（必須）・siteId（任意）をクエリ or ボディから取り出す。 */
export function readRoutingScope(
  source: Record<string, unknown> | URLSearchParams,
): { ok: true; tenantId: TenantId; siteId?: SiteId } | { ok: false; error: ScopeError } {
  const get = (key: string): string | undefined =>
    source instanceof URLSearchParams
      ? (source.get(key) ?? undefined)
      : typeof source[key] === 'string'
        ? (source[key] as string)
        : undefined;

  const tenantRaw = get('tenantId');
  if (!tenantRaw) return { ok: false, error: { code: 'invalid_input', message: 'tenantId is required' } };
  const siteRaw = get('siteId');
  return {
    ok: true,
    tenantId: asTenantId(tenantRaw),
    siteId: siteRaw ? asSiteId(siteRaw) : undefined,
  };
}

const STATUS_BY_CODE = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
} as const;

/** ServiceResult を NextResponse に変換する。invalid_input は issues を同梱する。 */
export function routingResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status: successStatus });
  return NextResponse.json(
    { error: result.error.code, message: result.error.message, ...(result.error.issues ? { issues: result.error.issues } : {}) },
    { status: STATUS_BY_CODE[result.error.code] },
  );
}
