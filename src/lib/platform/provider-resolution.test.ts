/**
 * テナント別プロバイダの実行時解決 `resolveProviderForTenant` のテスト (issue #405 Inc3)。
 *
 * 解決順: テナント設定(TenantProviderConfig + TenantSecretStore) → Mock。
 * env フォールバックは存在しない（グローバル VONAGE_* env 経路は撤去済み）。
 *
 * セキュリティ不変条件:
 *   - secret の値は `SecretValue`（redacted wrapper）のまま受け渡し、解決層で生値化しない。
 *   - 解決結果を serialize しても secret の平文が出ない（toJSON/String が [redacted]）。
 *   - テナント境界: あるテナントの設定・secret が別テナントの解決に漏れない。
 */
import { describe, expect, it } from 'vitest';
import { resolveProviderForTenant } from './provider-resolution';
import {
  InMemoryTenantSecretStore,
  SecretValue,
  secretRef,
  type TenantSecretStore,
} from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';

function config(overrides: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
  return {
    tenantId: 'tenant-a',
    provider: 'vonage',
    enabled: true,
    applicationId: 'app-123',
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'developer',
    ...overrides,
  };
}

/** 指定テナントにだけ設定を返す loadConfig を作る（越境しないことをテストで固定する）。 */
function loaderFor(map: Record<string, TenantProviderConfig>) {
  return async (tenantId: string): Promise<TenantProviderConfig | null> => map[tenantId] ?? null;
}

async function secretStoreWith(
  entries: Array<{ tenantId: string; value: string }>,
): Promise<TenantSecretStore> {
  const store = new InMemoryTenantSecretStore();
  for (const e of entries) {
    await store.setSecret(secretRef(e.tenantId, 'vonage'), new SecretValue(e.value));
  }
  return store;
}

describe('resolveProviderForTenant (#405 Inc3)', () => {
  it('テナント設定が無ければ Mock（既定挙動を維持）', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({}),
      secretStore: new InMemoryTenantSecretStore(),
    });
    expect(resolved.provider).toBe('mock');
  });

  it('provider=mock の設定は Mock', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({ 'tenant-a': config({ provider: 'mock' }) }),
      secretStore: await secretStoreWith([{ tenantId: 'tenant-a', value: 'TEST-bundle' }]),
    });
    expect(resolved.provider).toBe('mock');
  });

  it('vonage かつ enabled かつ secret set なら vonage（非秘密設定 + SecretValue を返す）', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({ 'tenant-a': config({ fromNumber: '+815000000000', timeoutMs: 8000 }) }),
      secretStore: await secretStoreWith([{ tenantId: 'tenant-a', value: 'TEST-secret-bundle' }]),
    });
    expect(resolved.provider).toBe('vonage');
    if (resolved.provider !== 'vonage') throw new Error('unreachable');
    expect(resolved.settings.applicationId).toBe('app-123');
    expect(resolved.settings.fromNumber).toBe('+815000000000');
    expect(resolved.settings.timeoutMs).toBe(8000);
    // secret は SecretValue のまま（生値化しない）。reveal() でのみ生値。
    expect(resolved.secret).toBeInstanceOf(SecretValue);
    expect(resolved.secret.reveal()).toBe('TEST-secret-bundle');
  });

  it('vonage でも disabled なら Mock', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({ 'tenant-a': config({ enabled: false }) }),
      secretStore: await secretStoreWith([{ tenantId: 'tenant-a', value: 'TEST-bundle' }]),
    });
    expect(resolved.provider).toBe('mock');
  });

  it('vonage・enabled でも secret 未設定なら Mock（fail-closed）', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({ 'tenant-a': config() }),
      secretStore: new InMemoryTenantSecretStore(),
    });
    expect(resolved.provider).toBe('mock');
  });

  it('テナント境界: 他テナントの設定・secret を解決しない', async () => {
    const loadConfig = loaderFor({ 'tenant-a': config({ tenantId: 'tenant-a' }) });
    const secretStore = await secretStoreWith([{ tenantId: 'tenant-a', value: 'TEST-a-secret' }]);
    // tenant-b には設定も secret も無い → Mock（tenant-a の値が漏れない）。
    const resolvedB = await resolveProviderForTenant('tenant-b', { loadConfig, secretStore });
    expect(resolvedB.provider).toBe('mock');
    // tenant-a は自分の secret のみ解決する。
    const resolvedA = await resolveProviderForTenant('tenant-a', { loadConfig, secretStore });
    expect(resolvedA.provider).toBe('vonage');
    if (resolvedA.provider !== 'vonage') throw new Error('unreachable');
    expect(resolvedA.secret.reveal()).toBe('TEST-a-secret');
  });

  it('解決結果を serialize しても secret 平文が出ない（redaction 不変条件）', async () => {
    const resolved = await resolveProviderForTenant('tenant-a', {
      loadConfig: loaderFor({ 'tenant-a': config() }),
      secretStore: await secretStoreWith([{ tenantId: 'tenant-a', value: 'TEST-must-not-leak' }]),
    });
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain('TEST-must-not-leak');
    expect(serialized).toContain('[redacted]');
  });
});
