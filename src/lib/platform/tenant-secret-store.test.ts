/**
 * secret ストアのプロセス共有ファクトリの backend 選択テスト (issue #405 Inc2)。
 *
 * `PROVIDER_SECRET_BACKEND` で in-memory / Secrets Manager を切替える。既定は memory（現行動作不変）。
 * 実 AWS 疎通は伴わない（構築のみ検証。実疎通は #65）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTenantSecretStore } from '@/domain/provider-config/secret';
import { SecretsManagerTenantSecretStore } from '@/domain/provider-config/secrets-manager-store';
import { createTenantSecretStore, __resetTenantSecretStore } from './tenant-secret-store';

afterEach(() => __resetTenantSecretStore());

describe('createTenantSecretStore — backend 選択 (#405 Inc2)', () => {
  it('既定（env 未指定）は in-memory（現行動作不変）', () => {
    expect(createTenantSecretStore({})).toBeInstanceOf(InMemoryTenantSecretStore);
  });

  it('PROVIDER_SECRET_BACKEND=memory は in-memory', () => {
    expect(createTenantSecretStore({ PROVIDER_SECRET_BACKEND: 'memory' })).toBeInstanceOf(
      InMemoryTenantSecretStore,
    );
  });

  it('PROVIDER_SECRET_BACKEND=secrets-manager は Secrets Manager 実装', () => {
    const store = createTenantSecretStore({
      PROVIDER_SECRET_BACKEND: 'secrets-manager',
      PROVIDER_SECRET_PREFIX: 'open-reception/prod',
      AWS_REGION: 'ap-northeast-1',
    });
    expect(store).toBeInstanceOf(SecretsManagerTenantSecretStore);
  });

  it('secrets-manager backend で prefix 未設定は fail-closed（構築を拒否）', () => {
    expect(() =>
      createTenantSecretStore({ PROVIDER_SECRET_BACKEND: 'secrets-manager' }),
    ).toThrow();
  });

  it('未知の backend 値は fail-closed（構築を拒否）', () => {
    expect(() => createTenantSecretStore({ PROVIDER_SECRET_BACKEND: 'dynamodb' })).toThrow();
  });
});
