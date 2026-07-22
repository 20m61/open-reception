/**
 * テナント設定由来の外部連携 presence (issue #90/#93 × #405 Inc3)。
 *
 * **server-only（client から import 不可）**: secret ストア（`TenantSecretStore`）を参照するため
 * 'use client' から import してはならない（`src/lib/security/client-secret-guard.test.ts` /
 * `src/domain/provider-config/server-only-import.test.ts` の静的解析が client への混入を防ぐ）。
 *
 * 役割:
 *   integrations 画面（/platform/integrations・/admin/integrations）の Vonage presence 表示を、
 *   旧グローバル `VONAGE_*` env の直読み（撤去済み `isVonageConfigured`/`isVonageEnabled`）から、
 *   テナント設定（`TenantProviderConfig` の provider/enabled）+ secret presence（`hasSecret`）へ
 *   移行する（#405 Inc3 の申し送り解消）。
 *
 * セキュリティ:
 *   - **値は一切返さない**。返すのは provider 種別と secret の presence（set|missing）、および
 *     それらから導く configured/enabled の状態のみ。secret 参照は `secretRef(tenantId,'vonage')` で
 *     名前空間分離し、`hasSecret`（存在判定）だけを呼ぶ（`getSecret` は使わない）。
 *   - 対象 `tenantId` は**呼び出し元の認可済みコンテキスト**から渡すこと（body/query 由来を使わない）。
 */
import type { ProviderId, SecretPresence } from '@/domain/provider-config/types';
import { secretRef, type TenantSecretStore } from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import { getTenantProviderConfig } from './provider-config-store';
import { getTenantSecretStore } from './tenant-secret-store';

/** 外部連携（Vonage）の presence。値は含めない（状態のみ）。 */
export type IntegrationPresence = {
  /** テナントが設定している provider 種別（未設定は 'none'）。 */
  provider: ProviderId | 'none';
  /** Vonage secret の存在（`set`|`missing`）。値は返さない。 */
  secretPresence: SecretPresence;
  /** 資格情報が揃い接続可能か（provider=vonage かつ secret set）。 */
  configured: boolean;
  /** configured かつテナント設定で有効化済みか。 */
  enabled: boolean;
};

/** テスト・呼び出し側で差し替え可能な依存（既定はプロセス共有のストア）。 */
export type IntegrationPresenceDeps = {
  loadConfig?: (tenantId: string) => Promise<TenantProviderConfig | null>;
  secretStore?: TenantSecretStore;
};

const NONE: IntegrationPresence = {
  provider: 'none',
  secretPresence: 'missing',
  configured: false,
  enabled: false,
};

/**
 * テナントの Vonage presence を組み立てる。`resolveProviderForTenant`（実行時解決）と同じ判定軸
 * （provider=vonage・enabled・vonage secret set）で presence を導き、表示と実発信可否の食い違いを防ぐ。
 * `tenantId` は認可済みコンテキスト由来のみ渡すこと（越境防止）。
 */
export async function getVonagePresenceForTenant(
  tenantId: string,
  deps: IntegrationPresenceDeps = {},
): Promise<IntegrationPresence> {
  const loadConfig = deps.loadConfig ?? getTenantProviderConfig;
  const config = await loadConfig(tenantId);
  if (!config) return NONE;

  const secretStore = deps.secretStore ?? getTenantSecretStore();
  const hasVonageSecret = await secretStore.hasSecret(secretRef(tenantId, 'vonage'));
  const secretPresence: SecretPresence = hasVonageSecret ? 'set' : 'missing';
  // 「設定済み」= provider=vonage かつ vonage secret set。provider=mock や secret 欠如は未設定扱い。
  const configured = config.provider === 'vonage' && hasVonageSecret;
  const enabled = configured && config.enabled;

  return { provider: config.provider, secretPresence, configured, enabled };
}
