/**
 * テナント別 secret ストアのプロセス共有ファクトリ (issue #405 Inc1 → Inc2)。
 *
 * **server-only（client から import 不可）**: secret 値を扱うため 'use client' から import しない
 * （`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
 *
 * backend は `PROVIDER_SECRET_BACKEND` env で切替える（Inc2）:
 *   - `memory`（既定・未指定時も）… in-memory mock。dev/test/CI の現行動作を不変に保つ。
 *   - `secrets-manager` … AWS Secrets Manager。参照名 `tenants/<tenantId>/<provider>` を
 *     `PROVIDER_SECRET_PREFIX`（例 `open-reception/prod`）配下のシークレット名へ写像する。
 *     prefix 未設定は fail-closed（越境防止のため構築段で拒否）。region は `AWS_REGION`。
 */
import { InMemoryTenantSecretStore, type TenantSecretStore } from '@/domain/provider-config/secret';
import {
  AwsSecretsManagerBackend,
  SecretsManagerTenantSecretStore,
} from '@/domain/provider-config/secrets-manager-store';

let store: TenantSecretStore | undefined;

/**
 * env から backend を選んで secret ストアを構築する（singleton は `getTenantSecretStore`）。
 * 未知の backend 値は fail-closed で拒否する（誤設定で secret を平文 memory に落とさない）。
 */
export function createTenantSecretStore(
  env: Record<string, string | undefined> = process.env,
): TenantSecretStore {
  const backend = env.PROVIDER_SECRET_BACKEND ?? 'memory';
  switch (backend) {
    case 'memory':
      return new InMemoryTenantSecretStore();
    case 'secrets-manager':
      return new SecretsManagerTenantSecretStore(
        new AwsSecretsManagerBackend(env.AWS_REGION ?? 'ap-northeast-1'),
        env.PROVIDER_SECRET_PREFIX ?? '',
      );
    default:
      throw new Error(`unknown PROVIDER_SECRET_BACKEND: ${backend}`);
  }
}

/** プロセス共有の secret ストア（既定 in-memory、`PROVIDER_SECRET_BACKEND` で切替）。 */
export function getTenantSecretStore(): TenantSecretStore {
  if (!store) store = createTenantSecretStore();
  return store;
}

/** テスト用に初期化する。 */
export function __resetTenantSecretStore(): void {
  store = undefined;
}
