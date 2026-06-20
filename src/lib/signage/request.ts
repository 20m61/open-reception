/**
 * サイネージ API のリクエスト解釈ヘルパ (issue #101, increment 1)。
 *
 * - tenantId/siteId のスコープ解釈（クエリ or ボディ、両方必須）。
 * - 更新ボディの正規化（型ガードのみ。内容の検証は service/rotation 側）。
 * - ServiceResult → HTTP 変換。
 *
 * actor 解決は中央モジュール @/lib/auth/actor を使う。認可は #80 の純関数（canAccessSite）
 * へ service が委譲する（docs/admin-actor-resolution-design.md）。
 */
import { NextResponse } from 'next/server';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import {
  asSignageItemId,
  isSignageContentType,
  type SignageItem,
} from '@/domain/signage/types';
import type { ServiceResult, UpdateSignageInput } from './service';

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
  if (!tenantId || !siteId) {
    return {
      ok: false,
      error: { code: 'invalid_input', message: 'tenantId and siteId are required' },
    };
  }
  return { ok: true, tenantId: asTenantId(tenantId), siteId: asSiteId(siteId) };
}

const STATUS_BY_CODE = {
  invalid_input: 400,
  forbidden: 403,
} as const;

/** ServiceResult を NextResponse に変換する。検証エラーはフィールド別に返す。 */
export function serviceResponse<T>(result: ServiceResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json(result.value, { status: successStatus });
  return NextResponse.json(
    { error: result.error.code, message: result.error.message, fields: result.error.fields },
    { status: STATUS_BY_CODE[result.error.code] },
  );
}

/** 1 項目を正規化する（型ガードのみ。内容検証は rotation.validateItem）。 */
function parseItem(raw: unknown, index: number): SignageItem {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const type = isSignageContentType(o.type) ? o.type : 'clock';
  const slideUrls = Array.isArray(o.slideUrls)
    ? o.slideUrls.filter((u): u is string => typeof u === 'string')
    : undefined;
  return {
    id: asSignageItemId(str('id') ?? `item-${index}`),
    type,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    title: str('title'),
    message: str('message'),
    imageUrl: str('imageUrl'),
    imageAlt: str('imageAlt'),
    slideUrls,
    durationSeconds: typeof o.durationSeconds === 'number' ? o.durationSeconds : undefined,
  };
}

/** 更新ボディを UpdateSignageInput へ。tenantId/siteId はスコープから渡す。 */
export function parseUpdateBody(
  body: unknown,
  tenantId: TenantId,
  siteId: SiteId,
): UpdateSignageInput {
  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items) ? o.items.map(parseItem) : [];
  return {
    tenantId,
    siteId,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : false,
    defaultIntervalSeconds: typeof o.defaultIntervalSeconds === 'number' ? o.defaultIntervalSeconds : 10,
    items,
  };
}
