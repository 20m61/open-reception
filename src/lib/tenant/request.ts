/**
 * 拠点（Site）管理 API のリクエスト解釈ヘルパ (issue #87, increment 1)。
 *
 * - actor（#80 の認可主体）の実解決は中央モジュール @/lib/auth/actor に集約済みで、
 *   ここからは互換のため re-export する（docs/admin-actor-resolution-design.md）。
 * - tenantId の取り出しとボディ正規化、ServiceResult → HTTP 変換。
 *
 * 認可そのものは #80 の純関数（canAccessTenant / canAccessSite）に委譲する。
 */
import { NextResponse } from 'next/server';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { ServiceResult } from './site-service';

export { resolveAdminActor } from '@/lib/auth/actor';

export type TenantScopeError = { code: 'invalid_input'; message: string };

/** tenantId をクエリ or ボディから取り出す（必須）。 */
export function readTenantScope(
  source: Record<string, unknown> | URLSearchParams,
): { ok: true; tenantId: TenantId } | { ok: false; error: TenantScopeError } {
  const raw =
    source instanceof URLSearchParams
      ? (source.get('tenantId') ?? undefined)
      : typeof source.tenantId === 'string'
        ? source.tenantId
        : undefined;
  if (!raw) return { ok: false, error: { code: 'invalid_input', message: 'tenantId is required' } };
  return { ok: true, tenantId: asTenantId(raw) };
}

/** siteId をクエリ or ボディから取り出す（必須・受付端末 API 用 issue #87 inc2）。 */
export function readSiteScope(
  source: Record<string, unknown> | URLSearchParams,
): { ok: true; siteId: SiteId } | { ok: false; error: TenantScopeError } {
  const raw =
    source instanceof URLSearchParams
      ? (source.get('siteId') ?? undefined)
      : typeof source.siteId === 'string'
        ? source.siteId
        : undefined;
  if (!raw) return { ok: false, error: { code: 'invalid_input', message: 'siteId is required' } };
  return { ok: true, siteId: asSiteId(raw) };
}

const STATUS_BY_CODE = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
} as const;

/** ServiceResult を NextResponse に変換する。 */
export function serviceResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status: successStatus });
  return NextResponse.json(
    { error: result.error.code, message: result.error.message },
    { status: STATUS_BY_CODE[result.error.code] },
  );
}

/** 後方互換のエイリアス（inc1 の site route が利用）。serviceResponse と同一。 */
export const siteResponse = serviceResponse;
