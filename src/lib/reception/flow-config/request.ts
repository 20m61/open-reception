/**
 * 受付フロー管理 API のリクエスト解釈ヘルパ (issue #100, increment 1)。
 *
 * - actor の実解決は中央モジュール @/lib/auth/actor（resolveAdminActor）を re-export する。
 * - tenantId（必須）・siteId（任意）の取り出しと ServiceResult → HTTP 変換。
 * 認可そのものは #80 純関数（canAccessSite）へ委譲する（service 層で適用）。
 */
import { NextResponse } from 'next/server';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { ServiceResult } from './service';

export { resolveAdminActor } from '@/lib/auth/actor';

export type ScopeError = { code: 'invalid_input'; message: string };

/** tenantId（必須）・siteId（任意）をクエリ or ボディから取り出す。 */
export function readFlowScope(
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

/** ServiceResult を NextResponse に変換する。 */
export function flowResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status: successStatus });
  return NextResponse.json(
    { error: result.error.code, message: result.error.message },
    { status: STATUS_BY_CODE[result.error.code] },
  );
}
