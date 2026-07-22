import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockPollyAdapter } from './polly-adapter';
import { HttpVonageAdapter, MockVonageAdapter, resolveVonageAdapterForTenant } from './vonage-adapter';
import { normalizeSiteConfig, InMemorySiteConfigLoader } from './site-config';
import {
  InMemoryTenantSecretStore,
  SecretValue,
  secretRef,
  type TenantSecretStore,
} from '@/domain/provider-config/secret';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import type { ResolveProviderDeps } from '@/lib/platform/provider-resolution';

// 通知接続情報 bundle（endpoint/token）は機密。擬似値のみを使う。
const NOTIFY_BUNDLE = JSON.stringify({ endpoint: 'https://x.test/notify', token: 'TEST-notify-token' });

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MockPollyAdapter', () => {
  it('returns mp3 base64 without leaking the text', async () => {
    const ref = await new MockPollyAdapter().synthesize('秘密の本文', {
      voiceId: 'Mizuki',
      languageCode: 'ja-JP',
      engine: 'neural',
    });
    expect(ref.format).toBe('mp3');
    expect(Buffer.from(ref.base64!, 'base64').toString()).not.toContain('秘密の本文');
  });
});

describe('MockVonageAdapter', () => {
  it('reports delivered and reflects synthesized flag', async () => {
    const res = await new MockVonageAdapter().notify(
      { type: 'phone', value: '+810000000000' },
      { requestId: 'r1', message: 'm', audio: { format: 'mp3', base64: 'x' } },
    );
    expect(res.status).toBe('delivered');
    expect(res.synthesized).toBe(true);
  });
});

describe('HttpVonageAdapter', () => {
  const adapter = new HttpVonageAdapter({ endpoint: 'https://x.test/notify', token: 't', timeoutMs: 50 });
  const target = { type: 'phone', value: '+810000000000' } as const;
  const payload = { requestId: 'r1', message: 'm' };

  it('classifies non-2xx as failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('err', { status: 500 })));
    const res = await adapter.notify(target, payload);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('upstream_status_500');
  });

  it('classifies AbortError as timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));
    const res = await adapter.notify(target, payload);
    expect(res.status).toBe('timeout');
  });

  it('reports delivered on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    const res = await adapter.notify(target, payload);
    expect(res.status).toBe('delivered');
  });
});

describe('resolveVonageAdapterForTenant (#405 Inc3)', () => {
  it('テナント設定が無ければ Mock（グローバル VONAGE_* env 経路は撤去済み）', async () => {
    const adapter = await resolveVonageAdapterForTenant('tenant-a', await depsFor(null));
    expect(adapter).toBeInstanceOf(MockVonageAdapter);
  });

  it('vonage・enabled・接続 bundle（endpoint+token）完備なら Http adapter', async () => {
    const adapter = await resolveVonageAdapterForTenant('tenant-a', await depsFor(vonageConfig(), NOTIFY_BUNDLE));
    expect(adapter).toBeInstanceOf(HttpVonageAdapter);
  });

  it('bundle に endpoint/token が無ければ Mock（fail-closed）', async () => {
    const badBundle = JSON.stringify({ endpoint: 'https://x.test/notify' });
    const adapter = await resolveVonageAdapterForTenant('tenant-a', await depsFor(vonageConfig(), badBundle));
    expect(adapter).toBeInstanceOf(MockVonageAdapter);
  });

  it('disabled なら Mock', async () => {
    const adapter = await resolveVonageAdapterForTenant(
      'tenant-a',
      await depsFor(vonageConfig({ enabled: false }), NOTIFY_BUNDLE),
    );
    expect(adapter).toBeInstanceOf(MockVonageAdapter);
  });
});

describe('normalizeSiteConfig', () => {
  it('defaults enabled to false and fills voice defaults', () => {
    const cfg = normalizeSiteConfig('s1', {});
    expect(cfg.enabled).toBe(false);
    expect(cfg.voice.voiceId).toBe('Mizuki');
  });
});

describe('InMemorySiteConfigLoader', () => {
  it('treats unknown sites as enabled by default (local dev)', async () => {
    const cfg = await new InMemorySiteConfigLoader().load('anything');
    expect(cfg?.enabled).toBe(true);
  });
});
