/**
 * テナント別プロバイダ secret の型安全ラッパとストア interface のテスト (issue #405 Inc1)。
 *
 * セキュリティ AC（すべて blocking）:
 *   - secret の値が serialize（toString/toJSON/テンプレートリテラル/console.log）で漏れない。
 *   - secret 参照名は `tenants/<tenantId>/<provider>` 名前空間で、path 脱出を許さない。
 *   - in-memory mock ストアの set/get/has/clear が round-trip し、clear 後は presence が false。
 *
 * 実 secret 風文字列は置かず、擬似値 `TEST-...` を使う（gitleaks 誤検知・実鍵混入防止）。
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { InMemoryTenantSecretStore, SecretValue, secretRef } from './secret';

const FAKE = 'TEST-vonage-api-secret-000';

describe('SecretValue — serialize 事故を型で防ぐ (#405 Inc1 AC3)', () => {
  it('toString / テンプレートリテラル は redact される', () => {
    const s = new SecretValue(FAKE);
    expect(s.toString()).toBe('[redacted]');
    expect(`${s}`).toBe('[redacted]');
    expect(String(s)).toBe('[redacted]');
    expect(`${s}`).not.toContain('TEST-');
  });

  it('JSON.stringify（単体・ネスト）で値が出ない', () => {
    const s = new SecretValue(FAKE);
    expect(JSON.stringify(s)).toBe('"[redacted]"');
    expect(JSON.stringify({ secret: s, keep: 'ok' })).toBe('{"secret":"[redacted]","keep":"ok"}');
    expect(JSON.stringify({ secret: s })).not.toContain('TEST-');
  });

  it('util.inspect / console.log 経路でも値が出ない', () => {
    const s = new SecretValue(FAKE);
    expect(inspect(s)).not.toContain('TEST-');
    expect(inspect({ nested: s })).not.toContain('TEST-');
  });

  it('reveal() でのみ生値が取り出せる（ストア/アダプタ内部専用）', () => {
    const s = new SecretValue(FAKE);
    expect(s.reveal()).toBe(FAKE);
  });
});

describe('secretRef — テナント名前空間 (#405 Inc1)', () => {
  it('tenants/<tenantId>/<provider> 形式', () => {
    expect(secretRef('acme', 'vonage')).toBe('tenants/acme/vonage');
    expect(secretRef('internal', 'mock')).toBe('tenants/internal/mock');
  });

  it('空 tenantId や区切り文字混入で名前空間を脱出させない', () => {
    expect(() => secretRef('', 'vonage')).toThrow();
    expect(() => secretRef('a/b', 'vonage')).toThrow();
    expect(() => secretRef('../evil', 'vonage')).toThrow();
  });
});

describe('InMemoryTenantSecretStore — mock 実装 (#405 Inc1)', () => {
  it('set → has/get で round-trip し、clear で presence が消える', async () => {
    const store = new InMemoryTenantSecretStore();
    const ref = secretRef('internal', 'vonage');

    expect(await store.hasSecret(ref)).toBe(false);
    expect(await store.getSecret(ref)).toBeNull();

    await store.setSecret(ref, new SecretValue(FAKE));
    expect(await store.hasSecret(ref)).toBe(true);
    const got = await store.getSecret(ref);
    expect(got).not.toBeNull();
    expect(got!.reveal()).toBe(FAKE);

    await store.clearSecret(ref);
    expect(await store.hasSecret(ref)).toBe(false);
    expect(await store.getSecret(ref)).toBeNull();
  });

  it('テナントごとに参照が分離している', async () => {
    const store = new InMemoryTenantSecretStore();
    await store.setSecret(secretRef('a', 'vonage'), new SecretValue('TEST-a'));
    expect(await store.hasSecret(secretRef('b', 'vonage'))).toBe(false);
    expect((await store.getSecret(secretRef('a', 'vonage')))!.reveal()).toBe('TEST-a');
  });
});
