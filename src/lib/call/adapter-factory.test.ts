import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCallAdapter,
  resolveVonageSessionService,
} from './adapter-factory';
import { MockCallAdapter } from '@/adapters/call/mock';
import { VonageCallAdapter } from '@/adapters/call/vonage';
import { RestVonageSessionService } from '@/adapters/call/vonage-session';
import { MOCK_STAFF } from '@/domain/staff/mock-data';
import {
  InMemoryTenantSecretStore,
  SecretValue,
  secretRef,
  type TenantSecretStore,
} from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import type { ResolveProviderDeps } from '@/lib/platform/provider-resolution';

// 通話資格情報 bundle（apiKey/apiSecret/privateKey）はすべて機密。擬似値のみを使う。
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

describe('resolveCallAdapter — テナント設定経由 (#405 Inc3)', () => {
  it('テナント設定が無ければ Mock', async () => {
    const adapter = await resolveCallAdapter('tenant-a', MOCK_STAFF, await depsFor(null));
    expect(adapter).toBeInstanceOf(MockCallAdapter);
  });

  it('vonage・enabled・bundle 完備なら Vonage adapter', async () => {
    const adapter = await resolveCallAdapter(
      'tenant-a',
      MOCK_STAFF,
      await depsFor(vonageConfig(), VONAGE_BUNDLE),
    );
    expect(adapter).toBeInstanceOf(VonageCallAdapter);
  });

  it('applicationId 欠如なら Mock（fail-closed）', async () => {
    const adapter = await resolveCallAdapter(
      'tenant-a',
      MOCK_STAFF,
      await depsFor(vonageConfig({ applicationId: undefined }), VONAGE_BUNDLE),
    );
    expect(adapter).toBeInstanceOf(MockCallAdapter);
  });

  it('bundle が不完全（privateKey 欠如）なら Mock（fail-closed）', async () => {
    const badBundle = JSON.stringify({ apiKey: 'TEST-k', apiSecret: 'TEST-s' });
    const adapter = await resolveCallAdapter(
      'tenant-a',
      MOCK_STAFF,
      await depsFor(vonageConfig(), badBundle),
    );
    expect(adapter).toBeInstanceOf(MockCallAdapter);
  });

  it('disabled なら Mock', async () => {
    const adapter = await resolveCallAdapter(
      'tenant-a',
      MOCK_STAFF,
      await depsFor(vonageConfig({ enabled: false }), VONAGE_BUNDLE),
    );
    expect(adapter).toBeInstanceOf(MockCallAdapter);
  });
});

describe('resolveVonageSessionService — テナント設定経由 (#405 Inc3)', () => {
  it('テナント設定が無ければ null', async () => {
    expect(await resolveVonageSessionService('tenant-a', await depsFor(null))).toBeNull();
  });

  it('vonage・enabled・bundle 完備なら session service', async () => {
    const svc = await resolveVonageSessionService(
      'tenant-a',
      await depsFor(vonageConfig(), VONAGE_BUNDLE),
    );
    expect(svc).toBeInstanceOf(RestVonageSessionService);
  });
});

describe('実発信不到達: 解決層は接続情報を返すのみ（実 HTTP/SDK に到達しない, #4）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('vonage+secret 完備でも resolveCallAdapter は fetch を呼ばない（解決＝接続情報のみ）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = await resolveCallAdapter(
      'tenant-a',
      MOCK_STAFF,
      await depsFor(vonageConfig(), VONAGE_BUNDLE),
    );
    expect(adapter).toBeInstanceOf(VonageCallAdapter);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('vonage+secret 完備でも resolveVonageSessionService は fetch を呼ばない', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = await resolveVonageSessionService('tenant-a', await depsFor(vonageConfig(), VONAGE_BUNDLE));
    expect(svc).toBeInstanceOf(RestVonageSessionService);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('VonageCallAdapter (#4)', () => {
  // session 作成が失敗しても受付フローを壊さず failed を返す。
  // 実ネットワークを呼ばないよう stub service を注入する（詳細は vonage-session.test.ts）。
  it('session 作成失敗時は failed を返す（受付フローを壊さない）', async () => {
    const failing = {
      createSession: async () => {
        throw new Error('boom');
      },
      issueToken: async () => {
        throw new Error('unused');
      },
    };
    const adapter = new VonageCallAdapter(
      { applicationId: 'a', apiKey: 'b', apiSecret: 'c', privateKey: 'd' },
      failing,
    );
    const r = await adapter.call({ receptionId: 'r1', targetType: 'staff', targetId: 'staff-sato' });
    expect(r.status).toBe('failed');
  });
});
