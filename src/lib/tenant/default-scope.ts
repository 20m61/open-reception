/**
 * 既定プロビジョニング・スコープの単一の真実源 (issue #171)。
 *
 * 単一テナント運用（および dev/test）における「既定のテナント/サイト」を一箇所で定義する。
 * これまで actor 解決・admin 画面・受付端末（kiosk）の各所が個別に 'internal'/'default'/
 * 'dev-tenant' をハードコードして食い違っていた（admin で作成したフローが端末に出ない等）。
 * 値は `lib/tenant/store.ts` の seed テナント（internal / default-site）に一致させ、
 * env（OPEN_RECEPTION_DEFAULT_TENANT_ID / _SITE_ID）で上書き可能にする。
 */
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';

/** 既定テナント ID（プロビジョニング済み seed テナント）。env 未指定時の fallback。 */
export const DEFAULT_TENANT_ID = 'internal';
/** 既定サイト ID（seed サイト）。env 未指定時の fallback。 */
export const DEFAULT_SITE_ID = 'default-site';

/** env から既定テナント ID（文字列）を解決する。actor 設定と共有する。 */
export function defaultTenantIdFrom(env: Record<string, string | undefined> = process.env): string {
  return env.OPEN_RECEPTION_DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID;
}

/** env から既定サイト ID（文字列）を解決する。 */
export function defaultSiteIdFrom(env: Record<string, string | undefined> = process.env): string {
  return env.OPEN_RECEPTION_DEFAULT_SITE_ID ?? DEFAULT_SITE_ID;
}

/**
 * 既定のテナント/サイト境界（ブランド型）を返す。受付端末（kiosk）が admin と同じ
 * テナントのフローを読むために使う。kiosk→デバイス→テナントの実解決は将来の増分で配線する。
 */
export function resolveDefaultScope(
  env: Record<string, string | undefined> = process.env,
): { tenantId: TenantId; siteId: SiteId } {
  return {
    tenantId: asTenantId(defaultTenantIdFrom(env)),
    siteId: asSiteId(defaultSiteIdFrom(env)),
  };
}
