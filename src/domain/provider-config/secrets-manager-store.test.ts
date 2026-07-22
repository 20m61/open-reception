/**
 * Secrets Manager 実装の `TenantSecretStore` のテスト (issue #405 Inc2)。
 *
 * 実 AWS を要さないよう、SDK client は `TenantSecretBackend` interface で注入し in-memory fake で
 * 差し替える（実 backend `AwsSecretsManagerBackend` は SDK 遅延解決の薄い層で、実疎通検証は #65）。
 *
 * 固定する AC（すべて blocking）:
 *   - 参照名 `tenants/<tenantId>/<provider>` を `<prefix>/tenants/<tenantId>/<provider>` へ写像する。
 *   - set は未存在で Create・存在で Put（冪等に再 set できる）。clear は Delete（未存在は no-op）。
 *   - presence は Describe 由来。削除予定（DeletedDate）は presence=false。
 *   - backend が投げたエラーのメッセージに secret 生値（TEST-...）が出ない（非漏洩）。
 *   - 区切り文字・path 脱出を含む ref を prefix 写像で拒否する（越境防止の継承）。
 *
 * 実 secret 風文字列は置かず擬似値 `TEST-...` を使う（gitleaks 誤検知・実鍵混入防止）。
 */
import { describe, expect, it, vi } from 'vitest';
import { SecretValue, secretRef, type TenantSecretStore } from './secret';
import {
  SecretsManagerTenantSecretStore,
  type TenantSecretBackend,
} from './secrets-manager-store';

const FAKE = 'TEST-vonage-api-secret-000';
const PREFIX = 'open-reception/test';

/** backend の呼び出し履歴を記録する in-memory fake（実 AWS 不要）。 */
class FakeBackend implements TenantSecretBackend {
  /** secretId → 値。undefined 値は「削除予定（DeletedDate 相当）」を表す。 */
  readonly secrets = new Map<string, string | undefined>();
  readonly calls: Array<{ op: string; secretId: string }> = [];

  async get(secretId: string): Promise<string | null> {
    this.calls.push({ op: 'get', secretId });
    const v = this.secrets.get(secretId);
    return v === undefined ? null : v;
  }

  async create(secretId: string, value: string): Promise<'created' | 'exists'> {
    this.calls.push({ op: 'create', secretId });
    if (this.secrets.has(secretId)) return 'exists';
    this.secrets.set(secretId, value);
    return 'created';
  }

  async put(secretId: string, value: string): Promise<void> {
    this.calls.push({ op: 'put', secretId });
    this.secrets.set(secretId, value);
  }

  async describe(secretId: string): Promise<boolean> {
    this.calls.push({ op: 'describe', secretId });
    return this.secrets.get(secretId) !== undefined;
  }

  async delete(secretId: string): Promise<void> {
    this.calls.push({ op: 'delete', secretId });
    this.secrets.delete(secretId);
  }
}

function makeStore(prefix = PREFIX): { store: TenantSecretStore; backend: FakeBackend } {
  const backend = new FakeBackend();
  const store = new SecretsManagerTenantSecretStore(backend, prefix);
  return { store, backend };
}

describe('SecretsManagerTenantSecretStore — 参照名の prefix 写像 (#405 Inc2)', () => {
  it('tenants/<tenantId>/<provider> を <prefix>/tenants/<tenantId>/<provider> へ写像する', async () => {
    const { store, backend } = makeStore();
    const ref = secretRef('acme', 'vonage');

    await store.setSecret(ref, new SecretValue(FAKE));

    expect(backend.secrets.has('open-reception/test/tenants/acme/vonage')).toBe(true);
    expect(backend.calls.every((c) => c.secretId.startsWith('open-reception/test/tenants/'))).toBe(
      true,
    );
  });

  it('prefix の前後スラッシュを正規化する（二重スラッシュを作らない）', async () => {
    const { store, backend } = makeStore('open-reception/test/');
    await store.setSecret(secretRef('acme', 'vonage'), new SecretValue(FAKE));
    expect(backend.secrets.has('open-reception/test/tenants/acme/vonage')).toBe(true);
  });

  it('空 prefix では構築を拒否する（fail-closed：越境防止）', () => {
    const backend = new FakeBackend();
    expect(() => new SecretsManagerTenantSecretStore(backend, '')).toThrow();
    expect(() => new SecretsManagerTenantSecretStore(backend, '   ')).toThrow();
  });

  it('path 脱出・区切り混入を含む ref を拒否する（secretRef ガードの継承）', async () => {
    const { store } = makeStore();
    await expect(store.setSecret('tenants/../evil', new SecretValue(FAKE))).rejects.toThrow();
    await expect(store.hasSecret('../escape')).rejects.toThrow();
    await expect(store.setSecret('', new SecretValue(FAKE))).rejects.toThrow();
    await expect(store.setSecret('/absolute/ref', new SecretValue(FAKE))).rejects.toThrow();
  });
});

describe('SecretsManagerTenantSecretStore — set/clear/presence/get の意味論 (#405 Inc2)', () => {
  it('未存在は Create、存在時は Put（冪等に再 set できる）', async () => {
    const { store, backend } = makeStore();
    const ref = secretRef('acme', 'vonage');
    const id = 'open-reception/test/tenants/acme/vonage';

    await store.setSecret(ref, new SecretValue(FAKE));
    expect(backend.calls.filter((c) => c.op === 'create' && c.secretId === id)).toHaveLength(1);

    await store.setSecret(ref, new SecretValue('TEST-rotated-001'));
    // 2 回目は Put（新バージョン）へ流れる。
    expect(backend.calls.some((c) => c.op === 'put' && c.secretId === id)).toBe(true);
    expect(backend.secrets.get(id)).toBe('TEST-rotated-001');
  });

  it('set → hasSecret/getSecret で round-trip し、clear で presence が消える', async () => {
    const { store } = makeStore();
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

  it('clear は未存在でも no-op（冪等）', async () => {
    const { store } = makeStore();
    await expect(store.clearSecret(secretRef('nobody', 'vonage'))).resolves.toBeUndefined();
  });

  it('テナントごとに参照が分離している', async () => {
    const { store } = makeStore();
    await store.setSecret(secretRef('a', 'vonage'), new SecretValue('TEST-a'));
    expect(await store.hasSecret(secretRef('b', 'vonage'))).toBe(false);
    expect((await store.getSecret(secretRef('a', 'vonage')))!.reveal()).toBe('TEST-a');
  });

  it('削除予定（DeletedDate 相当）は presence=false / get=null', async () => {
    const { store, backend } = makeStore();
    const ref = secretRef('acme', 'vonage');
    const id = 'open-reception/test/tenants/acme/vonage';
    // backend 上は存在するが値が undefined = 削除予定を表す。
    backend.secrets.set(id, undefined);
    expect(await store.hasSecret(ref)).toBe(false);
    expect(await store.getSecret(ref)).toBeNull();
  });
});

describe('SecretsManagerTenantSecretStore — 非漏洩 (#405 Inc2 セキュリティ)', () => {
  it('backend が投げた場合でもエラーメッセージに secret 生値が出ない', async () => {
    const backend = new FakeBackend();
    const store = new SecretsManagerTenantSecretStore(backend, PREFIX);
    vi.spyOn(backend, 'create').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'InternalServiceError' }),
    );
    let caught: unknown;
    try {
      await store.setSecret(secretRef('acme', 'vonage'), new SecretValue(FAKE));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain('TEST-');
    // 静的メッセージ（op を示すが値は含まない）。
    expect((caught as Error).message).toMatch(/secret/i);
  });
});
