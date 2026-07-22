/**
 * テナント別プロバイダの実行時解決 (issue #405 Inc3)。
 *
 * **server-only（client から import 不可）**: secret 値（`SecretValue`）を扱うため 'use client' から
 * import してはならない（`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
 *
 * 役割:
 *   受付/通知/通話の各生成点は、資格情報を **グローバル `VONAGE_*` env から読まず**、本層で
 *   テナント設定（`TenantProviderConfig` + `TenantSecretStore`）から解決する（Inc3 で env 経路を撤去）。
 *
 * 解決順（env フォールバックは存在しない）:
 *   1. テナント設定が provider='vonage' かつ enabled かつ secret set → **vonage**
 *      （非秘密設定 + secret を返す。secret は `SecretValue` の redacted wrapper のまま渡す）。
 *   2. それ以外（未設定 / provider='mock' / disabled / secret 未設定）→ **mock**（fail-closed）。
 *
 * セキュリティ:
 *   - 対象 `tenantId` は**呼び出し元の認可済みコンテキスト**から渡すこと（body/query 由来を使わない）。
 *     secret 参照名は `secretRef(tenantId, provider)`（`tenants/<tenantId>/<provider>`）で名前空間分離し、
 *     他テナントの secret を組み立てられない（Inc1 の `secret.ts` 契約）。
 *   - 本層は secret を**生値化しない**。`SecretValue` のまま返し、`reveal()` は接続情報を組む末端
 *     （adapter builder）でのみ呼ぶ。解決結果を serialize しても平文は出ない（`SecretValue.toJSON`）。
 */
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import { secretRef, type SecretValue, type TenantSecretStore } from '@/domain/provider-config/secret';
import { getTenantProviderConfig } from './provider-config-store';
import { getTenantSecretStore } from './tenant-secret-store';

/** 解決済みプロバイダ（判別可能 union）。 */
export type ResolvedProvider =
  | { provider: 'mock' }
  | {
      provider: 'vonage';
      /** 非秘密の接続設定（値はそのまま渡してよい）。 */
      settings: {
        applicationId?: string;
        fromNumber?: string;
        timeoutMs?: number;
      };
      /** 資格情報 bundle。redacted wrapper のまま。生値は末端 builder が reveal() する。 */
      secret: SecretValue;
    };

/** テスト・呼び出し側で差し替え可能な依存（既定はプロセス共有のストア）。 */
export type ResolveProviderDeps = {
  loadConfig?: (tenantId: string) => Promise<TenantProviderConfig | null>;
  secretStore?: TenantSecretStore;
};

const MOCK: ResolvedProvider = { provider: 'mock' };

/**
 * テナントの実行時プロバイダを解決する。テナント設定が無い/無効/secret 欠如なら Mock。
 * `tenantId` は認可済みコンテキスト由来のみ渡すこと（越境防止）。
 */
export async function resolveProviderForTenant(
  tenantId: string,
  deps: ResolveProviderDeps = {},
): Promise<ResolvedProvider> {
  const loadConfig = deps.loadConfig ?? getTenantProviderConfig;
  const config = await loadConfig(tenantId);
  if (!config || config.provider !== 'vonage' || !config.enabled) {
    return MOCK;
  }

  const secretStore = deps.secretStore ?? getTenantSecretStore();
  const secret = await secretStore.getSecret(secretRef(tenantId, 'vonage'));
  // enabled でも secret が無ければ実発信できない → Mock（fail-closed）。
  if (!secret) return MOCK;

  const settings: { applicationId?: string; fromNumber?: string; timeoutMs?: number } = {};
  if (config.applicationId !== undefined) settings.applicationId = config.applicationId;
  if (config.fromNumber !== undefined) settings.fromNumber = config.fromNumber;
  if (config.timeoutMs !== undefined) settings.timeoutMs = config.timeoutMs;

  return { provider: 'vonage', settings, secret };
}
