/**
 * 拠点（Site）管理 API のリクエスト解釈ヘルパ (issue #87, increment 1)。
 *
 * - actor（#80 の認可主体）の解決は来訪予約（#97）の resolveAdminActor を再利用する。
 *   本増分では Entra→AdminUser 写像が未配線のため、管理セッションが有効なら developer
 *   スコープの actor を返す暫定実装（docs/site-device-management-design.md §認可・既知の制約）。
 * - tenantId の取り出しとボディ正規化、ServiceResult → HTTP 変換。
 *
 * 認可そのものは #80 の純関数（canAccessTenant / canAccessSite）に委譲する。
 */
import { NextResponse } from 'next/server';
import { asTenantId, type TenantId } from '@/domain/tenant/types';
import type { ServiceResult } from './site-service';

export { resolveAdminActor } from '@/lib/reservation/request';

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

const STATUS_BY_CODE = {
  invalid_input: 400,
  not_found: 404,
  forbidden: 403,
} as const;

/** ServiceResult を NextResponse に変換する。 */
export function siteResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status: successStatus });
  return NextResponse.json(
    { error: result.error.code, message: result.error.message },
    { status: STATUS_BY_CODE[result.error.code] },
  );
}
