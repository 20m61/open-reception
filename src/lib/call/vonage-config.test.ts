/**
 * 公開 applicationId のテナント設定解決（#4 tenant threading）。
 * 旧グローバル `VONAGE_APPLICATION_ID` env 経路の撤去後、applicationId はテナント設定
 * （`TenantProviderConfig.applicationId`）から server-only で解決する。未設定は null（機能無効）。
 * secret（bundle）は返さないこと・解決層が実 HTTP に到達しないことも固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVonagePublicConfigForTenant } from './vonage-config';
import {
  InMemoryTenantSecretStore,
  SecretValue,
  secretRef,
  type TenantSecretStore,
} from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import type { ResolveProviderDeps } from '@/lib/platform/provider-resolution';

// 通話資格情報 bundle（apiKey/apiSecret/privateKey）は機密。擬似値のみ。
const VONAGE_BUNDLE = JSON.stringify({
  apiKey: 'TEST-api-key',
  apiSecret: 'TEST-api-secret',
  privateKey: 'TEST-private-key',
});

function vonageConfig(overrides: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
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

async function depsFor(
  config: TenantProviderConfig | null,
  bundle?: string,
): Promise<ResolveProviderDeps> {
  const secretStore: TenantSecretStore = new InMemoryTenantSecretStore();
  if (bundle !== undefined) {
    await secretStore.setSecret(secretRef('tenant-a', 'vonage'), new SecretValue(bundle));
  }
  return {
    loadConfig: async (tenantId) => (tenantId === 'tenant-a' ? config : null),
    secretStore,
  };
}

describe('getVonagePublicConfigForTenant — テナント設定由来の公開 applicationId (#4)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('vonage・enabled・secret set・applicationId 設定済みなら applicationId を返す', async () => {
    const config = await getVonagePublicConfigForTenant('tenant-a', await depsFor(vonageConfig(), VONAGE_BUNDLE));
    expect(config).toEqual({ applicationId: 'app-123' });
  });

  it('未設定テナント（設定なし）は null', async () => {
    expect(await getVonagePublicConfigForTenant('tenant-a', await depsFor(null))).toBeNull();
  });

  it('disabled は null', async () => {
    const config = await getVonagePublicConfigForTenant(
      'tenant-a',
      await depsFor(vonageConfig({ enabled: false }), VONAGE_BUNDLE),
    );
    expect(config).toBeNull();
  });

  it('secret 未設定は null（fail-closed。provider 解決が mock になる）', async () => {
    expect(await getVonagePublicConfigForTenant('tenant-a', await depsFor(vonageConfig()))).toBeNull();
  });

  it('applicationId 未設定は null', async () => {
    const config = await getVonagePublicConfigForTenant(
      'tenant-a',
      await depsFor(vonageConfig({ applicationId: undefined }), VONAGE_BUNDLE),
    );
    expect(config).toBeNull();
  });

  it('公開値のみ: 返り値に secret（apiKey/apiSecret/privateKey）を含めない', async () => {
    const config = await getVonagePublicConfigForTenant('tenant-a', await depsFor(vonageConfig(), VONAGE_BUNDLE));
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/TEST-api-key|TEST-api-secret|TEST-private-key|apiKey|apiSecret|privateKey/);
  });

  it('解決は実 HTTP に到達しない（fetch を呼ばない）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await getVonagePublicConfigForTenant('tenant-a', await depsFor(vonageConfig(), VONAGE_BUNDLE));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
