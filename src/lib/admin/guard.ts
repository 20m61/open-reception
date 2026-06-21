/**
 * admin route/layout 用のサーバ側ガードヘルパ (issue #91, increment 1)。
 *
 * 目的: 各 admin route が手書きしていた「actor 解決 → 401」「テナント境界 → 403」を
 * 一貫した形に集約し、401/403 のレスポンス形を揃える。`route-guard.ts`（フロント表示用）
 * とは責務が異なる: こちらは **API 側の最終認可** を担う薄いラッパで、判定そのものは
 * #80 の純関数（canAccessTenant / canAccessSite）へ委譲する。
 *
 * 設計方針:
 *   - 判定の本体は純粋（assertActor / assertCanWrite* は AdminGuardError を throw するだけ）。
 *     I/O は requireActor（resolveAdminActor 呼び出し）のみ。
 *   - route 側は try/catch して toGuardResponse(err) で 401/403 を返す。これにより
 *     「フロントで隠した操作でも API 側で 403 になる」(#91 受け入れ条件) を一箇所で保証する。
 */
import { NextResponse } from 'next/server';
import {
  canAccessSite,
  canAccessTenant,
  type Actor,
} from '@/domain/tenant/authorization';
import { asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { buildActorConfig, resolveAdminActor } from '@/lib/auth/actor';

/** ガード違反。HTTP ステータスと安定したエラーコードを持つ（本文に機微値は含めない）。 */
export class AdminGuardError extends Error {
  readonly status: 401 | 403;
  readonly code: 'unauthorized' | 'forbidden';

  constructor(status: 401 | 403, code: 'unauthorized' | 'forbidden', message?: string) {
    super(message ?? code);
    this.name = 'AdminGuardError';
    this.status = status;
    this.code = code;
  }
}

/** 401 unauthorized を表す AdminGuardError。 */
export function unauthorized(message?: string): AdminGuardError {
  return new AdminGuardError(401, 'unauthorized', message);
}

/** 403 forbidden を表す AdminGuardError。 */
export function forbidden(message?: string): AdminGuardError {
  return new AdminGuardError(403, 'forbidden', message);
}

/**
 * 管理セッションから actor を解決する。未認証なら AdminGuardError(401) を throw する
 * （route 側で toGuardResponse に渡す）。唯一の I/O 境界。
 */
export async function requireActor(): Promise<Actor> {
  const actor = await resolveAdminActor();
  if (!actor) throw unauthorized();
  return actor;
}

/**
 * 単一テナント運用の既定テナント ID（env 由来）。tenantId を URL/body で受け取らない
 * 旧 admin route（部署・担当者・端末・アセット・モーション・音声・受付/監査ログ等）の
 * 認可スコープに使う。複数テナント分離が必要になった route は scope を明示すること。
 */
export function defaultAdminTenantId(): TenantId {
  return asTenantId(buildActorConfig().defaultTenantId);
}

/** actor が指定テナントへ書き込めることを表明する。不可なら 403。純粋（throw のみ）。 */
export function assertCanWrite(actor: Actor, tenantId: TenantId): void {
  if (!canAccessTenant(actor, tenantId, 'write')) throw forbidden();
}

/** actor が指定テナントを読めることを表明する。不可なら 403。 */
export function assertCanRead(actor: Actor, tenantId: TenantId): void {
  if (!canAccessTenant(actor, tenantId, 'read')) throw forbidden();
}

/** actor が指定サイトへ書き込めることを表明する（site_manager 境界を含む）。不可なら 403。 */
export function assertCanWriteSite(actor: Actor, tenantId: TenantId, siteId: SiteId): void {
  if (!canAccessSite(actor, tenantId, siteId, 'write')) throw forbidden();
}

/** actor が指定サイトを読めることを表明する。不可なら 403。 */
export function assertCanReadSite(actor: Actor, tenantId: TenantId, siteId: SiteId): void {
  if (!canAccessSite(actor, tenantId, siteId, 'read')) throw forbidden();
}

/**
 * AdminGuardError を一貫した HTTP レスポンスへ変換する。route の catch から呼ぶ。
 * AdminGuardError 以外（想定外）は再 throw し、ガードが本物のバグを飲み込まないようにする。
 */
export function toGuardResponse(err: unknown): NextResponse {
  if (err instanceof AdminGuardError) {
    return NextResponse.json({ error: err.code }, { status: err.status });
  }
  throw err;
}
