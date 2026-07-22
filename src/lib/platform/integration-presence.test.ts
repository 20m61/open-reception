import { describe, expect, it } from 'vitest';
import { InMemoryTenantSecretStore, SecretValue, secretRef } from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import { getVonagePresenceForTenant } from './integration-presence';

/**
 * テナント設定由来の Vonage presence (issue #90/#93 × #405 Inc3)。
 *
 * 旧グローバル `VONAGE_*` env の presence 判定を、テナント設定（provider/enabled）+ secret presence
 * （set|missing）へ移行した。**値は一切返さない**（configured/enabled/secretPresence の状態のみ）。
 */

const TENANT = 'internal';

function config(overrides: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
  return {
    tenantId: TENANT,
    provider: 'vonage',
    enabled: true,
    applicationId: 'app-123',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'platform:dev',
    ...overrides,
  };
}

async function withSecret(store: InMemoryTenantSecretStore): Promise<InMemoryTenantSecretStore> {
  await store.setSecret(secretRef(TENANT, 'vonage'), new SecretValue('TEST-vonage-bundle'));
  return store;
}

describe('getVonagePresenceForTenant (#90/#93 × #405)', () => {
  it('テナント設定が無ければ provider=none / missing / 未設定', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => null,
      secretStore: new InMemoryTenantSecretStore(),
    });
    expect(presence).toEqual({
      provider: 'none',
      secretPresence: 'missing',
      configured: false,
      enabled: false,
    });
  });

  it('provider=vonage かつ secret set かつ enabled → 設定済み(configured)・有効(enabled)', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => config(),
      secretStore: await withSecret(new InMemoryTenantSecretStore()),
    });
    expect(presence.provider).toBe('vonage');
    expect(presence.secretPresence).toBe('set');
    expect(presence.configured).toBe(true);
    expect(presence.enabled).toBe(true);
  });

  it('secret 未設定なら configured=false / secretPresence=missing（enabled でも）', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => config(),
      secretStore: new InMemoryTenantSecretStore(),
    });
    expect(presence.secretPresence).toBe('missing');
    expect(presence.configured).toBe(false);
    expect(presence.enabled).toBe(false);
  });

  it('secret set でも enabled=false なら configured=true / enabled=false', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => config({ enabled: false }),
      secretStore: await withSecret(new InMemoryTenantSecretStore()),
    });
    expect(presence.configured).toBe(true);
    expect(presence.enabled).toBe(false);
  });

  it('provider=mock なら vonage としては未設定（secret set でも configured=false）', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => config({ provider: 'mock' }),
      secretStore: await withSecret(new InMemoryTenantSecretStore()),
    });
    expect(presence.provider).toBe('mock');
    expect(presence.configured).toBe(false);
    expect(presence.enabled).toBe(false);
  });

  it('secret の値は結果に一切現れない（平文非露出）', async () => {
    const presence = await getVonagePresenceForTenant(TENANT, {
      loadConfig: async () => config(),
      secretStore: await withSecret(new InMemoryTenantSecretStore()),
    });
    expect(JSON.stringify(presence)).not.toContain('TEST-vonage-bundle');
    expect(Object.keys(presence)).not.toContain('secret');
  });
});
