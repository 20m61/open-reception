/**
 * platform 破壊的操作の登録入力の共通検証ヘルパ (issue #83 inc4c)。
 *
 * incident / maintenance など複数の登録 write が同じ規則（スコープ整合・ISO 正規化・trim）を持つため、
 * ここに集約して重複と乖離を防ぐ（各 build* から呼ぶ）。純関数・I/O なし。
 */

/** 影響範囲（platform 系で共通）。下位ほど上位 id を要する。 */
export type PlatformScope = 'platform' | 'tenant' | 'site' | 'device';

export const PLATFORM_SCOPES: readonly PlatformScope[] = ['platform', 'tenant', 'site', 'device'];

/** 文字列を trim（非文字列は空文字）。 */
export function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ISO へ正規化する（read の辞書順ソートが ISO 前提のため、非 ISO の parse 可能値も揃える）。
 * 空/parse 不能は null。
 */
export function toIso(raw: string): string | null {
  if (raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** スコープ id 検証の結果（成功時は当該スコープに正規化した id 群）。 */
export type ScopeIds = { tenantId?: string; siteId?: string; deviceId?: string };

/**
 * スコープと id の整合を検証し、当該スコープで有効な id のみに絞る。
 *   - tenant → tenantId 必須、site/device → siteId 必須、device → deviceId 必須。
 *   - platform は下位 id を落とす（上位スコープに下位 id を残さない）。
 */
export function validateScopeIds(
  scope: PlatformScope,
  input: { tenantId?: unknown; siteId?: unknown; deviceId?: unknown },
): { ok: true; ids: ScopeIds } | { ok: false; error: string } {
  const tenantId = trimStr(input.tenantId) || undefined;
  const siteId = trimStr(input.siteId) || undefined;
  const deviceId = trimStr(input.deviceId) || undefined;
  if (scope !== 'platform' && !tenantId) return { ok: false, error: 'tenantId required for this scope' };
  if ((scope === 'site' || scope === 'device') && !siteId) return { ok: false, error: 'siteId required for this scope' };
  if (scope === 'device' && !deviceId) return { ok: false, error: 'deviceId required for this scope' };
  return {
    ok: true,
    ids: {
      tenantId: scope === 'platform' ? undefined : tenantId,
      siteId: scope === 'site' || scope === 'device' ? siteId : undefined,
      deviceId: scope === 'device' ? deviceId : undefined,
    },
  };
}
