/**
 * 営業時間ポリシー admin API のリクエスト解釈ヘルパ (issue #367)。
 *
 * `src/lib/routing/request.ts`（#374）と同種の役割だが、並行トラックの共有ファイルに依存しない
 * よう本トラック専用に薄く複製する（tenantId/siteId 抽出、identity 付き actor 解決）。
 */
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { Actor } from '@/domain/tenant/authorization';
import { unauthorized } from '@/lib/admin/guard';
import { resolveAdminActorWithIdentity } from '@/lib/auth/actor';

export type ScopeError = { code: 'invalid_input'; message: string };

/** tenantId・siteId（両方必須。営業時間ポリシーはサイト単位）をクエリ or ボディから取り出す。 */
export function readOperatingScope(
  source: Record<string, unknown> | URLSearchParams,
): { ok: true; tenantId: TenantId; siteId: SiteId } | { ok: false; error: ScopeError } {
  const get = (key: string): string | undefined =>
    source instanceof URLSearchParams
      ? (source.get(key) ?? undefined)
      : typeof source[key] === 'string'
        ? (source[key] as string)
        : undefined;

  const tenantRaw = get('tenantId');
  if (!tenantRaw) return { ok: false, error: { code: 'invalid_input', message: 'tenantId is required' } };
  const siteRaw = get('siteId');
  if (!siteRaw) return { ok: false, error: { code: 'invalid_input', message: 'siteId is required' } };
  return { ok: true, tenantId: asTenantId(tenantRaw), siteId: asSiteId(siteRaw) };
}

/**
 * actor + 操作者識別子（email/subject。無ければ 'password-admin'）を解決する。未認証は 401
 * （`@/lib/admin/guard` の `AdminGuardError` を throw。route 側で `toGuardResponse` に渡す）。
 * `updatedBy`（ServiceOperatingPolicy）の記録に使う。
 */
export async function requireActorWithIdentity(): Promise<{ actor: Actor; identity: string }> {
  const resolved = await resolveAdminActorWithIdentity();
  if (!resolved) throw unauthorized();
  return resolved;
}
