import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockPollyAdapter } from './polly-adapter';
import { HttpVonageAdapter, MockVonageAdapter, createVonageAdapter } from './vonage-adapter';
import { normalizeSiteConfig, InMemorySiteConfigLoader } from './site-config';

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

describe('createVonageAdapter', () => {
  it('returns MockVonageAdapter when endpoint/token are absent', () => {
    expect(createVonageAdapter({})).toBeInstanceOf(MockVonageAdapter);
    expect(createVonageAdapter({ VONAGE_NOTIFY_ENDPOINT: 'https://x' })).toBeInstanceOf(MockVonageAdapter);
  });

  it('returns HttpVonageAdapter when endpoint and token are both set', () => {
    const adapter = createVonageAdapter({
      VONAGE_NOTIFY_ENDPOINT: 'https://x.test/notify',
      VONAGE_NOTIFY_TOKEN: 'tok',
    });
    expect(adapter).toBeInstanceOf(HttpVonageAdapter);
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
