/**
 * 滞在 API のリクエスト解釈ヘルパ (issue #102, increment 1)。
 *
 * - kiosk セッションの検証（#23 readKioskSession を再利用）。端末からの要求であることを担保。
 * - admin の tenantId/siteId スコープ取り出しと ServiceResult → HTTP 変換。
 * - 退館失敗理由 → HTTP ステータスの対応。
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { asStayId, type StayId } from '@/domain/visit/types';
import type { CheckoutFailureReason } from './kiosk-service';
import type { ServiceResult } from './service';

// actor 解決の実装は中央モジュールへ集約。route から使うため re-export する。
export { resolveAdminActor } from '@/lib/auth/actor';

/** 有効な kiosk セッションを要求する。無効なら null。 */
export async function requireKioskSession(): Promise<{ kioskId: string } | null> {
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  return readKioskSession(cookie);
}

/** 退館失敗理由ごとの HTTP ステータス。 */
const STATUS_BY_REASON: Record<CheckoutFailureReason, number> = {
  invalid: 400,
  not_found: 404,
  already_checked_out: 409,
};

export function checkoutFailureResponse(reason: CheckoutFailureReason): NextResponse {
  return NextResponse.json({ error: reason }, { status: STATUS_BY_REASON[reason] });
}

/** リクエストボディから受付番号（stayId）を取り出す。 */
export function readStayId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const v = (body as Record<string, unknown>).stayId;
  return typeof v === 'string' ? v : null;
}

export function toStayId(id: string): StayId {
  return asStayId(id);
}

export type ScopeError = { code: 'invalid_input'; message: string };

/** tenantId/siteId をクエリ or ボディから取り出す。両方必須。 */
export function readScope(
  source: Record<string, unknown> | URLSearchParams,
): { ok: true; tenantId: TenantId; siteId: SiteId } | { ok: false; error: ScopeError } {
  const get = (k: string): string | undefined => {
    if (source instanceof URLSearchParams) return source.get(k) ?? undefined;
    const v = source[k];
    return typeof v === 'string' ? v : undefined;
  };
  const tenantId = get('tenantId');
  const siteId = get('siteId');
  if (!tenantId || !siteId)
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'tenantId and siteId are required' },
    };
  return { ok: true, tenantId: asTenantId(tenantId), siteId: asSiteId(siteId) };
}

const STATUS_BY_CODE = {
  invalid_input: 400,
  invalid_state: 409,
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
