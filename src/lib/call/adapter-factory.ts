/**
 * 呼び出し adapter の選択 (issue #4, #20 / #405 Inc3)。
 *
 * 資格情報の供給源は **グローバル `VONAGE_*` env ではなく、テナント設定**
 * （`resolveProviderForTenant`）へ移行済み（#405 Inc3 で env 経路を撤去）。
 *   - `resolveCallAdapter(tenantId, staff)` … テナント解決結果に応じて Vonage / Mock。
 *   - `resolveVonageSessionService(tenantId)` … 同上（未解決なら null）。
 *
 * 旧 API（`getCallAdapter` / `getVonageSessionService`）は tenantId を取らない後方互換シムで、
 * env を一切読まず常に Mock を返す（グローバル既定 = Mock）。tenantId を持てる呼び出し点は
 * `resolve*` へ移行する（#4 の Provider 実結線でテナントコンテキストを配線）。
 */
import type { CallAdapter } from '@/adapters/call/types';
import type { Staff } from '@/domain/staff/types';
import { MockCallAdapter } from '@/adapters/call/mock';
import { VonageCallAdapter } from '@/adapters/call/vonage';
import { RestVonageSessionService, type VonageSessionService } from '@/adapters/call/vonage-session';
import {
  resolveProviderForTenant,
  type ResolveProviderDeps,
  type ResolvedProvider,
} from '@/lib/platform/provider-resolution';
import type { VonageConfig } from './vonage-config';

/**
 * 解決済み vonage プロバイダから `VonageConfig` を組み立てる。
 * applicationId は非秘密設定、api key/secret/private key は secret bundle（JSON）から取り出す。
 * 生値化は本関数（末端の builder）でのみ行う。不備があれば null（→ 呼び出し側は Mock へ fail-closed）。
 */
function buildVonageConfig(resolved: Extract<ResolvedProvider, { provider: 'vonage' }>): VonageConfig | null {
  const applicationId = resolved.settings.applicationId;
  if (!applicationId) return null;
  let bundle: { apiKey?: unknown; apiSecret?: unknown; privateKey?: unknown };
  try {
    bundle = JSON.parse(resolved.secret.reveal());
  } catch {
    return null;
  }
  const { apiKey, apiSecret, privateKey } = bundle;
  if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || typeof privateKey !== 'string') {
    return null;
  }
  return {
    applicationId,
    apiKey,
    apiSecret,
    // PEM を 1 行 secret に入れる際の \n エスケープを実改行へ戻す。
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

/**
 * テナント設定に基づく通話 adapter を解決する。vonage 解決かつ bundle 完備なら本番 adapter、
 * それ以外は Mock（既定）。**外部実発信は #4 の外部待ち**（本層は資格情報の供給源のみ切替）。
 */
export async function resolveCallAdapter(
  tenantId: string,
  staff: ReadonlyArray<Staff>,
  deps?: ResolveProviderDeps,
): Promise<CallAdapter> {
  const resolved = await resolveProviderForTenant(tenantId, deps);
  if (resolved.provider === 'vonage') {
    const config = buildVonageConfig(resolved);
    if (config) return new VonageCallAdapter(config);
  }
  return new MockCallAdapter(staff);
}

/**
 * テナント設定に基づくトークン発行用 session service を解決する。未解決なら null。
 * token API（受付端末/担当者へ短命トークンを配布）から使う。
 */
export async function resolveVonageSessionService(
  tenantId: string,
  deps?: ResolveProviderDeps,
): Promise<VonageSessionService | null> {
  const resolved = await resolveProviderForTenant(tenantId, deps);
  if (resolved.provider !== 'vonage') return null;
  const config = buildVonageConfig(resolved);
  return config ? new RestVonageSessionService(config) : null;
}

/**
 * @deprecated tenantId を取らない後方互換シム。env を読まず常に Mock を返す
 *   （グローバル `VONAGE_*` env 経路は #405 Inc3 で撤去）。テナント解決には `resolveCallAdapter` を使う。
 */
export function getCallAdapter(staff: ReadonlyArray<Staff>): CallAdapter {
  return new MockCallAdapter(staff);
}

/**
 * @deprecated tenantId を取らない後方互換シム。env を読まず常に null を返す
 *   （グローバル `VONAGE_*` env 経路は #405 Inc3 で撤去）。テナント解決には `resolveVonageSessionService` を使う。
 */
export function getVonageSessionService(): VonageSessionService | null {
  return null;
}
