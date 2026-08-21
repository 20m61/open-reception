/**
 * 非秘密設定ストアのテスト (issue #405 Inc1 / #762 Inc2)。
 *
 * blocking AC2: 保存レコードに secret の値も部分値も入らない（型で持たないことを serialize でも確認）。
 *
 * #762: Inc1 の実体は**プロセス内 `Map`** だった。OpenNext の Lambda は複数インスタンスで
 * 動くので、管理 API を処理したインスタンスだけが設定を持ち、受付端末のリクエストを処理する
 * 別インスタンスからは**見えない**。つまり実 Vonage 資格情報を入れても本番では効かない
 * （効くかどうかがリクエストごとに変わる）。永続バックエンドへ載せる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenantProviderConfig } from '@/domain/provider-config/types';
import {
  __resetProviderConfigStore,
  deleteTenantProviderConfig,
  getTenantProviderConfig,
  putTenantProviderConfig,
} from './provider-config-store';
import { getBackend } from '@/lib/data';
import { PLATFORM_PROVIDER_CONFIG_COLLECTION } from './repository';

function cfg(over: Partial<TenantProviderConfig> = {}): TenantProviderConfig {
  return {
    tenantId: 'internal',
    provider: 'vonage',
    enabled: true,
    applicationId: 'app-1',
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'platform:dev@example.com',
    ...over,
  };
}

beforeEach(async () => {
  await __resetProviderConfigStore();
});

describe('provider-config-store (#405 Inc1)', () => {
  it('put → get で round-trip し、delete で消える', async () => {
    expect(await getTenantProviderConfig('internal')).toBeNull();
    await putTenantProviderConfig(cfg());
    expect((await getTenantProviderConfig('internal'))?.provider).toBe('vonage');
    await deleteTenantProviderConfig('internal');
    expect(await getTenantProviderConfig('internal')).toBeNull();
  });

  it('テナントごとに分離している', async () => {
    await putTenantProviderConfig(cfg({ tenantId: 'internal', provider: 'vonage' }));
    await putTenantProviderConfig(cfg({ tenantId: 'acme', provider: 'mock' }));
    expect((await getTenantProviderConfig('acme'))?.provider).toBe('mock');
    expect((await getTenantProviderConfig('internal'))?.provider).toBe('vonage');
  });

  it('保存レコードに secret 由来キーが無い（AC2）', async () => {
    await putTenantProviderConfig(cfg());
    const stored = await getTenantProviderConfig('internal');
    const json = JSON.stringify(stored);
    expect(json).not.toMatch(/secret|privatekey|token|password|apikey/i);
  });
});

describe('永続バックエンドに載っている (#762)', () => {
  /**
   * 🔴 **プロセス内 `Map` ではないこと。** ここが最重要 ── Inc1 の実体は module scope の
   * `Map` で、Lambda インスタンスをまたぐと消えていた。バックエンドの collection を
   * **直接**読んで、同じレコードが引けることを見る（ストア関数越しでは Map でも通る）。
   */
  it('🔴 バックエンドの collection に書かれている', async () => {
    await putTenantProviderConfig(cfg({ tenantId: 'internal' }));
    const stored = await getBackend()
      .collection<{ id: string; provider: string }>(PLATFORM_PROVIDER_CONFIG_COLLECTION)
      .get('internal');
    expect(stored?.provider).toBe('vonage');
  });

  /** キーはテナント ID そのもの（越境参照名を組ませない）。 */
  it('🔴 レコードの id がテナント ID', async () => {
    await putTenantProviderConfig(cfg({ tenantId: 'acme' }));
    const stored = await getBackend()
      .collection<{ id: string }>(PLATFORM_PROVIDER_CONFIG_COLLECTION)
      .get('acme');
    expect(stored?.id).toBe('acme');
  });

  /**
   * 🔴 **既知の非秘密フィールドだけを保存する。** 型は防いでくれるが、
   * route が検証を落とした/呼び出し元が増えたときに、ストアが最後の砦になる
   * （`rules/pii-secret-minimization.md`「設定ストアに secret を保存しない」）。
   */
  it('🔴 未知のキーを保存しない（secret 風のキーが紛れても落とす）', async () => {
    const dirty = {
      ...cfg(),
      apiSecret: 'TEST-must-not-persist',
      privateKey: 'TEST-must-not-persist',
    } as unknown as TenantProviderConfig;
    await putTenantProviderConfig(dirty);
    const stored = await getBackend()
      .collection<{ id: string } & Record<string, unknown>>(PLATFORM_PROVIDER_CONFIG_COLLECTION)
      .get('internal');
    expect(JSON.stringify(stored)).not.toContain('TEST-must-not-persist');
  });

  /** 任意フィールドは持っていれば保存し、無ければ書かない（undefined を撒かない）。 */
  it('任意フィールドを保存する', async () => {
    await putTenantProviderConfig(cfg({ fromNumber: '+815000000000', timeoutMs: 3000 }));
    const stored = await getTenantProviderConfig('internal');
    expect(stored?.fromNumber).toBe('+815000000000');
    expect(stored?.timeoutMs).toBe(3000);
  });

  it('未設定の任意フィールドはレコードに現れない', async () => {
    await putTenantProviderConfig(cfg());
    const stored = await getBackend()
      .collection<{ id: string } & Record<string, unknown>>(PLATFORM_PROVIDER_CONFIG_COLLECTION)
      .get('internal');
    expect(stored).not.toHaveProperty('fromNumber');
    expect(stored).not.toHaveProperty('timeoutMs');
  });

  /** 上書きが前の値を残さない（enabled を落としたのに残る、が起きない）。 */
  it('上書きで前の任意フィールドが残らない', async () => {
    await putTenantProviderConfig(cfg({ fromNumber: '+815000000000' }));
    await putTenantProviderConfig(cfg({ enabled: false }));
    const stored = await getTenantProviderConfig('internal');
    expect(stored?.enabled).toBe(false);
    expect(stored?.fromNumber).toBeUndefined();
  });
});
