/**
 * buildTenantProviderConfig の検証テスト (issue #405 Inc1)。
 *
 * blocking セキュリティ AC:
 *   - 設定ストアに入る config に secret の値も部分値も入らない（whitelist コピー）。
 *   - secret 風キーを送るとバリデーションエラーになり、そのエラー文言に値が echo されない（AC1）。
 */
import { describe, expect, it } from 'vitest';
import { buildTenantProviderConfig } from './config';

const CTX = { tenantId: 'internal', now: new Date('2026-07-22T00:00:00.000Z'), updatedBy: 'platform:dev@example.com' };

describe('buildTenantProviderConfig — 正常系 (#405 Inc1)', () => {
  it('非秘密設定のみを whitelist して config を組み立てる', () => {
    const r = buildTenantProviderConfig(
      { provider: 'vonage', enabled: true, applicationId: 'app-1', fromNumber: '+815000000000', timeoutMs: 4000 },
      CTX,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      tenantId: 'internal',
      provider: 'vonage',
      enabled: true,
      applicationId: 'app-1',
      fromNumber: '+815000000000',
      timeoutMs: 4000,
      updatedAt: '2026-07-22T00:00:00.000Z',
      updatedBy: 'platform:dev@example.com',
    });
  });

  it('未指定の enabled は false 既定・任意項目は省略', () => {
    const r = buildTenantProviderConfig({ provider: 'mock' }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.enabled).toBe(false);
    expect(r.value).not.toHaveProperty('applicationId');
    expect(r.value).not.toHaveProperty('timeoutMs');
  });
});

describe('buildTenantProviderConfig — 検証エラー (#405 Inc1)', () => {
  it('未知の provider を弾く', () => {
    const r = buildTenantProviderConfig({ provider: 'twilio', enabled: true }, CTX);
    expect(r.ok).toBe(false);
  });

  it('不正な timeoutMs（非正・上限超）を弾く', () => {
    expect(buildTenantProviderConfig({ provider: 'mock', timeoutMs: 0 }, CTX).ok).toBe(false);
    expect(buildTenantProviderConfig({ provider: 'mock', timeoutMs: -1 }, CTX).ok).toBe(false);
    expect(buildTenantProviderConfig({ provider: 'mock', timeoutMs: 10_000_000 }, CTX).ok).toBe(false);
  });

  it('secret 風キーを含む入力は拒否し、エラー文言に値を echo しない（AC1/AC2）', () => {
    const secretish = { provider: 'vonage', enabled: true, apiSecret: 'TEST-should-never-appear-123' };
    const r = buildTenantProviderConfig(secretish, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toContain('TEST-should-never-appear-123');
  });

  it('privateKey / token / password / apiKey も config へ入れさせない', () => {
    for (const key of ['privateKey', 'token', 'password', 'secret', 'apiKey']) {
      const r = buildTenantProviderConfig(
        { provider: 'mock', [key]: 'TEST-x' } as Record<string, unknown>,
        CTX,
      );
      expect(r.ok, `${key} は拒否されるべき`).toBe(false);
    }
  });

  it('正常系 config を JSON 化しても secret 由来キーが現れない（AC2）', () => {
    const r = buildTenantProviderConfig({ provider: 'vonage', enabled: true, applicationId: 'app-1' }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const json = JSON.stringify(r.value);
    expect(json).not.toMatch(/secret|privatekey|token|password|apikey/i);
  });
});
