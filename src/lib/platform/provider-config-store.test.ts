/**
 * 非秘密設定ストアのテスト (issue #405 Inc1)。
 * blocking AC2: 保存レコードに secret の値も部分値も入らない（型で持たないことを serialize でも確認）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import {
  __resetProviderConfigStore,
  deleteTenantProviderConfig,
  getTenantProviderConfig,
  putTenantProviderConfig,
} from './provider-config-store';

function cfg(over: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
  return {
    tenantId: 'internal',
    provider: 'vonage',
    enabled: true,
    applicationId: 'app-1',
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'platform:dev@example.com',
    ...over,
  };
}

beforeEach(() => __resetProviderConfigStore());

describe('provider-config-store (#405 Inc1)', () => {
  it('put → get で round-trip し、delete で消える', async () => {
    expect(await getTenantProviderConfig('internal')).toBeNull();
    await putTenantProviderConfig(cfg());
    expect((await getTenantProviderConfig('internal'))?.provider).toBe('vonage');
    await deleteTenantProviderConfig('internal');
    expect(await getTenantProviderConfig('internal')).toBeNull();
  });

  it('テナントごとに分離している', async () => {
    await putTenantProviderConfig(cfg({ tenantId: 'internal', provider: 'vonage' }));
    await putTenantProviderConfig(cfg({ tenantId: 'acme', provider: 'mock' }));
    expect((await getTenantProviderConfig('acme'))?.provider).toBe('mock');
    expect((await getTenantProviderConfig('internal'))?.provider).toBe('vonage');
  });

  it('保存レコードに secret 由来キーが無い（AC2）', async () => {
    await putTenantProviderConfig(cfg());
    const stored = await getTenantProviderConfig('internal');
    const json = JSON.stringify(stored);
    expect(json).not.toMatch(/secret|privatekey|token|password|apikey/i);
  });
});
