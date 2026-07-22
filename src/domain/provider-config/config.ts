/**
 * TenantProviderConfig の検証・組み立て（純関数） (issue #405 Inc1)。
 *
 * client-safe（secret 値は扱わない）。**非秘密設定だけを whitelist コピー**して config を作る。
 * secret 風キー（apiSecret/privateKey/token/password/secret/apiKey 等）が入力に混ざっていたら
 * 拒否する（AC2: 設定ストアに secret の値も部分値も入れない / AC1: エラーに値を echo しない）。
 */
import { isProviderId, type TenantProviderConfig } from './types';

export type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 入力に混ざっていたら拒否する secret 風キー（小文字・部分一致）。設定と secret 経路を分離する。 */
const SECRET_KEY_PATTERNS = [
  'secret',
  'privatekey',
  'private_key',
  'apikey',
  'api_key',
  'token',
  'password',
  'passwd',
  'credential',
] as const;

function hasSecretishKey(input: Record<string, unknown>): boolean {
  return Object.keys(input).some((k) => {
    const lower = k.toLowerCase();
    return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
  });
}

const APP_ID_MAX = 200;
const FROM_NUMBER_MAX = 32;
const TIMEOUT_MAX_MS = 120_000;

/**
 * 検証して TenantProviderConfig を組み立てる。ctx.tenantId は認可済みコンテキスト由来（AC4）。
 * エラー文言は静的（入力値を echo しない）。
 */
export function buildTenantProviderConfig(
  input: Record<string, unknown>,
  ctx: { tenantId: string; now: Date; updatedBy: string },
): BuildResult<TenantProviderConfig> {
  // 設定 API に secret を送らせない。混入時は値を echo せず静的メッセージで拒否する。
  if (hasSecretishKey(input)) {
    return { ok: false, error: 'secret value must not be sent to the config endpoint' };
  }

  if (!isProviderId(input.provider)) {
    return { ok: false, error: 'invalid provider' };
  }

  const config: TenantProviderConfig = {
    tenantId: ctx.tenantId,
    provider: input.provider,
    enabled: input.enabled === undefined ? false : Boolean(input.enabled),
    updatedAt: ctx.now.toISOString(),
    updatedBy: ctx.updatedBy,
  };

  if (input.applicationId !== undefined) {
    if (typeof input.applicationId !== 'string') return { ok: false, error: 'invalid applicationId' };
    const v = input.applicationId.trim();
    if (v.length > APP_ID_MAX) return { ok: false, error: 'applicationId too long' };
    if (v) config.applicationId = v;
  }

  if (input.fromNumber !== undefined) {
    if (typeof input.fromNumber !== 'string') return { ok: false, error: 'invalid fromNumber' };
    const v = input.fromNumber.trim();
    if (v.length > FROM_NUMBER_MAX) return { ok: false, error: 'fromNumber too long' };
    if (v) config.fromNumber = v;
  }

  if (input.timeoutMs !== undefined) {
    const n = input.timeoutMs;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > TIMEOUT_MAX_MS) {
      return { ok: false, error: 'invalid timeoutMs' };
    }
    config.timeoutMs = n;
  }

  return { ok: true, value: config };
}
