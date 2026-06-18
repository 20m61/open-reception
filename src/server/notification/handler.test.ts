import { describe, it, expect, beforeEach } from 'vitest';
import { processNotification, type NotificationDeps } from './handler';
import { MockPollyAdapter } from './polly-adapter';
import { MockVonageAdapter, type VonageAdapter, type NotifyPayload } from './vonage-adapter';
import { InMemorySiteConfigLoader } from './site-config';
import type { NotificationResult, NotificationTarget, SiteConfig } from './types';

const SITE: SiteConfig = {
  siteId: 'site-001',
  enabled: true,
  defaultTarget: { type: 'phone', value: '+819000000000' },
  voice: { voiceId: 'Mizuki', languageCode: 'ja-JP', engine: 'neural' },
};

function makeDeps(overrides: Partial<NotificationDeps> = {}): NotificationDeps & { logs: Record<string, unknown>[] } {
  const logs: Record<string, unknown>[] = [];
  return {
    loader: new InMemorySiteConfigLoader({ 'site-001': SITE }),
    polly: new MockPollyAdapter(),
    vonage: new MockVonageAdapter(),
    seen: new Set<string>(),
    log: (e) => logs.push(e),
    logs,
    ...overrides,
  };
}

const baseReq = {
  siteId: 'site-001',
  requestId: 'req-1',
  kind: 'call',
  message: 'お客様がお見えです',
};

describe('processNotification', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('delivers a valid request and synthesizes audio', async () => {
    const res = await processNotification(baseReq, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('delivered');
    expect(res.body.synthesized).toBe(true);
  });

  it('returns 400 on invalid input', async () => {
    const res = await processNotification({ siteId: 'x' }, deps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects unknown/disabled site with 403', async () => {
    const res = await processNotification({ ...baseReq, siteId: 'ghost' }, deps);
    expect(res.statusCode).toBe(403);
    const disabledDeps = makeDeps({
      loader: new InMemorySiteConfigLoader({ 'site-001': { ...SITE, enabled: false } }),
    });
    expect((await processNotification(baseReq, disabledDeps)).statusCode).toBe(403);
  });

  it('returns 400 when no target can be resolved', async () => {
    const noTargetDeps = makeDeps({
      loader: new InMemorySiteConfigLoader({ 'site-001': { ...SITE, defaultTarget: undefined } }),
    });
    const res = await processNotification(baseReq, noTargetDeps);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('no_target');
  });

  it('is idempotent: duplicate requestId is not re-sent', async () => {
    await processNotification(baseReq, deps);
    const res = await processNotification(baseReq, deps);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('duplicate');
  });

  it('falls back to text when synthesis fails', async () => {
    const failingPolly = {
      synthesize: async () => {
        throw new Error('PollyError');
      },
    };
    const res = await processNotification(baseReq, makeDeps({ polly: failingPolly }));
    expect(res.statusCode).toBe(200);
    expect(res.body.synthesized).toBe(false);
  });

  it('maps timeout to 504 and failure to 502', async () => {
    const timeoutVonage: VonageAdapter = {
      notify: async (_t: NotificationTarget, p: NotifyPayload): Promise<NotificationResult> => ({
        status: 'timeout',
        requestId: p.requestId,
        synthesized: Boolean(p.audio),
      }),
    };
    expect((await processNotification(baseReq, makeDeps({ vonage: timeoutVonage }))).statusCode).toBe(504);

    const failVonage: VonageAdapter = {
      notify: async (_t, p) => ({ status: 'failed', requestId: p.requestId, synthesized: false }),
    };
    expect((await processNotification(baseReq, makeDeps({ vonage: failVonage }))).statusCode).toBe(502);
  });

  it('does not log PII (message/target value) in structured logs', async () => {
    await processNotification(baseReq, deps);
    const serialized = JSON.stringify(deps.logs);
    expect(serialized).not.toContain('お客様がお見えです');
    expect(serialized).not.toContain('+819000000000');
  });
});
