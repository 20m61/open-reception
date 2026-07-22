/**
 * TenantProviderConfig の型・射影・provider union のテスト (issue #405 Inc1)。
 *
 * - provider は 'mock' | 'vonage' の union（将来 CCaaS 追加可能）。
 * - API/画面へ出す射影（view）は非秘密設定 + secret presence のみで、secret 値・操作者識別子を持たない。
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_IDS,
  isProviderId,
  toProviderConfigView,
  type TenantProviderConfig,
} from './types';

const CONFIG: TenantProviderConfig = {
  tenantId: 'internal',
  provider: 'vonage',
  enabled: true,
  applicationId: 'app-123',
  fromNumber: '+815000000000',
  timeoutMs: 5000,
  updatedAt: '2026-07-22T00:00:00.000Z',
  updatedBy: 'platform:dev@example.com',
};

describe('provider union (#405 Inc1)', () => {
  it('PROVIDER_IDS は mock と vonage を含む', () => {
    expect(PROVIDER_IDS).toContain('mock');
    expect(PROVIDER_IDS).toContain('vonage');
  });

  it('isProviderId は未知の provider を弾く', () => {
    expect(isProviderId('vonage')).toBe(true);
    expect(isProviderId('mock')).toBe(true);
    expect(isProviderId('twilio')).toBe(false);
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(42)).toBe(false);
  });
});

describe('toProviderConfigView — 射影 (#405 Inc1)', () => {
  it('非秘密設定 + secretPresence を出し、操作者識別子(updatedBy)を出さない', () => {
    const view = toProviderConfigView(CONFIG, 'set');
    expect(view).toEqual({
      tenantId: 'internal',
      provider: 'vonage',
      enabled: true,
      applicationId: 'app-123',
      fromNumber: '+815000000000',
      timeoutMs: 5000,
      secretPresence: 'set',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(view).not.toHaveProperty('updatedBy');
  });

  it('presence は set|missing を素通しする（値は持たない）', () => {
    expect(toProviderConfigView(CONFIG, 'missing').secretPresence).toBe('missing');
    const serialized = JSON.stringify(toProviderConfigView(CONFIG, 'set'));
    expect(serialized).not.toMatch(/secretValue|apiSecret|privateKey/i);
  });
});
