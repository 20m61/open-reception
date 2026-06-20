/**
 * 来訪予約 API のリクエスト解釈ヘルパ (issue #97, increment 1)。
 *
 * - 管理セッションの検証（#24 の signSession/verifySession を再利用）。
 * - リクエストから actor（#80 の認可主体）を解決する。
 * - tenantId/siteId とボディの正規化、ServiceResult → HTTP 変換。
 *
 * 認可は #80 の純関数（canAccessSite）に委譲する。actor の解決は本増分では
 * Entra→AdminUser 写像が未配線のため、管理セッションが有効なら developer スコープの
 * actor を返す暫定実装とする（docs/visit-reservation-design.md §認可・既知の制約）。
 * 実 AdminUser 解決は次増分で TenantStore / Entra クレームから行う。
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { Actor } from '@/domain/tenant/authorization';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  type CreateReservationInput,
  type EditReservationPatch,
  type ReservationId,
} from '@/domain/reservation/types';
import { ADMIN_COOKIE, ENTRA_TOKEN_COOKIE, getAdminSecret } from '@/lib/auth/admin';
import { verifySession } from '@/lib/auth/session';
import type { ServiceResult } from './service';

/**
 * 管理セッションが有効かを判定する。password / entra いずれの cookie でも、
 * 署名・期限が有効なら true。
 */
export async function hasValidAdminSession(): Promise<boolean> {
  const jar = await cookies();
  const admin = await verifySession(jar.get(ADMIN_COOKIE)?.value, getAdminSecret());
  if (admin && admin.role === 'admin') return true;
  // Entra トークン cookie がある場合も管理セッションとみなす（検証は #70 の経路）。
  return Boolean(jar.get(ENTRA_TOKEN_COOKIE)?.value);
}

/**
 * 認可主体を解決する。本増分では管理セッションが有効なら developer 相当の actor を返す。
 * 無効なら null（route 側で 401）。
 */
export async function resolveAdminActor(): Promise<Actor | null> {
  if (!(await hasValidAdminSession())) return null;
  return {
    status: 'active',
    assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
  };
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

export function toReservationId(id: string): ReservationId {
  return asReservationId(id);
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

/** 既定の有効期限を usagePolicy から導出する（同日 23:59:59Z / 単回は visitAt+7d）。 */
function defaultExpiresAt(visitAt: string, usagePolicy: string): string {
  const base = new Date(Date.parse(visitAt));
  if (usagePolicy === 'same_day') {
    return new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 23, 59, 59),
    ).toISOString();
  }
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString();
}

const DEFAULT_RETENTION_DAYS = 30;

/** 作成リクエストボディを CreateReservationInput へ。検証は service/lifecycle 側。 */
export function parseCreateBody(
  body: unknown,
  tenantId: TenantId,
  siteId: SiteId,
): { ok: true; value: CreateReservationInput } | { ok: false; error: ScopeError } {
  if (typeof body !== 'object' || body === null)
    return { ok: false, error: { code: 'invalid_input', message: 'body must be an object' } };
  const o = body as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof o[k] === 'string' ? (o[k] as string) : undefined;
  const usagePolicy = (str('usagePolicy') ?? 'single_use') as CreateReservationInput['usagePolicy'];
  const visitAt = str('visitAt') ?? '';
  const value: CreateReservationInput = {
    tenantId,
    siteId,
    visitorName: str('visitorName') ?? '',
    companyName: str('companyName'),
    visitAt,
    note: str('note'),
    targetType: (str('targetType') ?? 'staff') as CreateReservationInput['targetType'],
    targetId: str('targetId') ?? '',
    usagePolicy,
    expiresAt: str('expiresAt') ?? (visitAt ? defaultExpiresAt(visitAt, usagePolicy) : ''),
    retentionDays: typeof o.retentionDays === 'number' ? o.retentionDays : DEFAULT_RETENTION_DAYS,
  };
  return { ok: true, value };
}

/** 編集ボディを EditReservationPatch へ（指定されたフィールドのみ）。 */
export function parseEditBody(body: unknown): EditReservationPatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: EditReservationPatch = {};
  if (typeof o.visitorName === 'string') patch.visitorName = o.visitorName;
  if (typeof o.companyName === 'string') patch.companyName = o.companyName;
  if (typeof o.visitAt === 'string') patch.visitAt = o.visitAt;
  if (typeof o.note === 'string') patch.note = o.note;
  if (o.targetType === 'staff' || o.targetType === 'department') patch.targetType = o.targetType;
  if (typeof o.targetId === 'string') patch.targetId = o.targetId;
  if (o.usagePolicy === 'single_use' || o.usagePolicy === 'same_day')
    patch.usagePolicy = o.usagePolicy;
  if (typeof o.expiresAt === 'string') patch.expiresAt = o.expiresAt;
  if (typeof o.retentionDays === 'number') patch.retentionDays = o.retentionDays;
  return patch;
}
