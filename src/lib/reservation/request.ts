/**
 * 来訪予約 API のリクエスト解釈ヘルパ (issue #97, increment 1)。
 *
 * - 管理セッションの検証（#24 の signSession/verifySession を再利用）。
 * - リクエストから actor（#80 の認可主体）を解決する。
 * - tenantId/siteId とボディの正規化、ServiceResult → HTTP 変換。
 *
 * 認可は #80 の純関数（canAccessSite）に委譲する。actor の実解決（実セッション/Entra
 * クレーム → 境界付き RoleAssignment）は中央モジュール @/lib/auth/actor に集約済みで、
 * ここからは互換のため re-export する（docs/admin-actor-resolution-design.md）。
 */
import { NextResponse } from 'next/server';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import {
  asReservationId,
  type CreateReservationInput,
  type EditReservationPatch,
  type ReservationId,
  type VisitReservation,
} from '@/domain/reservation/types';
import type { ServiceResult } from './service';

// actor 解決の実装は中央モジュールへ集約。既存 import 互換のため re-export する。
export { hasValidAdminSession, resolveAdminActor } from '@/lib/auth/actor';

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

/**
 * HTTP 応答用の view 変換: 永続レコードの `tokenHash` を落とす (issue #375 I1)。
 *
 * `tokenHash` は受付照合専用の内部値で、応答/画面には不要（`.claude/rules/pii-secret-minimization.md`）。
 * `ReservationService.get`/`list` 自体は（内部利用・既存テストの通り）`tokenHash` を含む
 * `VisitReservation` を返し続けるが、admin API の HTTP 応答はこの view を通して露出を止める。
 * `IssuedReservation`（`create`/`reissueToken` の一度きり応答）にも適用可能（`token` は保持される）。
 */
export function toReservationView<T extends VisitReservation>(r: T): Omit<T, 'tokenHash'> {
  const { tokenHash: _tokenHash, ...view } = r;
  return view;
}

/**
 * ServiceResult を NextResponse に変換する。`transform` を渡すと ok 時の value をそれで
 * 写してから応答する（tokenHash 除去などの view 変換に使う, #375 I1）。
 */
export function serviceResponse<T, V = T>(
  result: ServiceResult<T>,
  successStatus = 200,
  transform?: (value: T) => V,
): NextResponse {
  if (result.ok) {
    const body = transform ? transform(result.value) : result.value;
    return NextResponse.json(body, { status: successStatus });
  }
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
