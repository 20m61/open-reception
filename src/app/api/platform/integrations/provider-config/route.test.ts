/**
 * GET/PUT /api/platform/integrations/provider-config の認可・射影・AC テスト (issue #405 Inc1)。
 *
 * blocking:
 *   - 未認証 401 / 非 developer 403（authorizePlatform 一点集約）。
 *   - tenantId は選択中テナント Cookie（認可済みコンテキスト）由来のみ。body.tenantId は無視（AC4）。
 *   - 設定 API に secret を送ると 400（設定ストアへ secret を入れない, AC2）。
 *   - 応答に secret 値・操作者識別子(updatedBy)を載せない（AC1）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type Tenant } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const getTenant = vi.fn<(id: unknown) => Promise<Tenant | undefined>>();
const cookieGet = vi.fn<() => { value: string } | undefined>(() => undefined);
const recordDangerAction = vi.fn<(i: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { getTenant: (id: unknown) => getTenant(id) } }),
}));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i) }));

import { GET, PUT } from './route';
import { __resetProviderConfigStore, getTenantProviderConfig } from '@/lib/platform/provider-config-store';
import { __resetTenantSecretStore } from '@/lib/platform/tenant-secret-store';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }],
  };
}
const TENANT: Tenant = {
  id: asTenantId('internal'),
  name: '社内',
  slug: 'internal',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function put(body: unknown) {
  return PUT(
    new Request('http://t/api/platform/integrations/provider-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetProviderConfigStore();
  __resetTenantSecretStore();
  resolveAdminActor.mockResolvedValue(developer());
  getTenant.mockResolvedValue({ ...TENANT });
  cookieGet.mockReturnValue({ value: 'internal' });
  recordDangerAction.mockResolvedValue({});
});

describe('認可 (#405 Inc1)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await put({ provider: 'mock' })).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await GET()).status).toBe(403);
    expect((await put({ provider: 'mock' })).status).toBe(403);
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('テナント未選択は 400 / 実在しないテナントは 404', async () => {
    cookieGet.mockReturnValue(undefined);
    expect((await GET()).status).toBe(400);
    cookieGet.mockReturnValue({ value: 'ghost' });
    getTenant.mockResolvedValue(undefined);
    expect((await GET()).status).toBe(404);
  });
});

describe('GET — read (#405 Inc1)', () => {
  it('未設定なら config:null / presence missing', async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ config: null, secretPresence: 'missing', warnings: [] });
  });

  it('設定済みなら非秘密設定 + presence を返し、updatedBy を出さない (AC1)', async () => {
    await put({ provider: 'vonage', enabled: true, applicationId: 'app-1' });
    const body = await (await GET()).json();
    expect(body.config.provider).toBe('vonage');
    expect(body.config.secretPresence).toBe('missing');
    expect(body.config).not.toHaveProperty('updatedBy');
  });
});

describe('PUT — 非秘密設定 upsert (#405 Inc1)', () => {
  it('provider を保存し integration.updated を監査する', async () => {
    const res = await put({ provider: 'vonage', enabled: true });
    expect(res.status).toBe(200);
    expect((await getTenantProviderConfig('internal'))?.provider).toBe('vonage');
    expect(recordDangerAction).toHaveBeenCalledTimes(1);
    const arg = recordDangerAction.mock.calls[0]![0] as { action: string };
    expect(arg.action).toBe('integration.updated');
  });

  it('secret 風キーを送ると 400（設定ストアへ secret を入れない, AC2）', async () => {
    const res = await put({ provider: 'vonage', enabled: true, apiSecret: 'TEST-should-not-store' });
    expect(res.status).toBe(400);
    const stored = await getTenantProviderConfig('internal');
    expect(JSON.stringify(stored)).not.toContain('TEST-should-not-store');
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('body.tenantId は無視し、コンテキスト(cookie)由来テナントに保存する (AC4)', async () => {
    // cookie は internal。body で acme を主張しても internal に保存されること。
    await put({ provider: 'vonage', enabled: true, tenantId: 'acme' });
    // buildTenantProviderConfig は tenantId を入力から取らないため secret 風でもないが、
    // 保存先が internal である（＝コンテキスト由来）ことを確認する。
    expect(await getTenantProviderConfig('internal')).not.toBeNull();
    expect(await getTenantProviderConfig('acme')).toBeNull();
    const stored = await getTenantProviderConfig('internal');
    expect(stored?.tenantId).toBe('internal');
  });

  it('不正な provider は 400', async () => {
    expect((await put({ provider: 'twilio' })).status).toBe(400);
  });
});

/**
 * secret を入れる前に「有効」にできてしまう問題への警告 (#763)。
 *
 * 2026-08-21 のユーザー判断は**「警告して保存は通す」**。「設定を先に保存 →
 * secret を後で入れる」という二段階の運用導線を壊さないため、拒否はしない。
 */
describe('取り次げない設定を警告する (#763)', () => {
  it('🔴 secret 未設定で実発信を意図する設定を保存すると警告が返る', async () => {
    const res = await put({
      provider: 'vonage',
      enabled: true,
      applicationId: 'TEST-app',
      fromNumber: '+815000000000',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toContain('real_dialing_without_secret');
  });

  /** 🔴 **保存は通す。** 拒否すると二段階の運用導線が壊れる。 */
  it('🔴 警告が出ても保存は成立する', async () => {
    const res = await put({
      provider: 'vonage',
      enabled: true,
      applicationId: 'TEST-app',
      fromNumber: '+815000000000',
    });
    expect(res.status).toBe(200);
    expect(await getTenantProviderConfig('internal')).not.toBeNull();
  });

  /**
   * 🔴 **読み取りにも載せる。** 保存直後だけ出す形にすると、画面を開き直した運用者には
   * 「未接続」としか見えず、受付が 503 になっている理由に辿り着けない。
   */
  it('🔴 読み取り応答にも同じ警告が載る', async () => {
    await put({
      provider: 'vonage',
      enabled: true,
      applicationId: 'TEST-app',
      fromNumber: '+815000000000',
    });
    const body = (await (await GET()).json()) as { warnings: string[] };
    expect(body.warnings).toContain('real_dialing_without_secret');
  });

  /** 意図が無い設定（Video 専用・mock）を警告で埋めない。 */
  it('Video 専用（発信元番号なし）では警告しない', async () => {
    const res = await put({ provider: 'vonage', enabled: true, applicationId: 'TEST-app' });
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings).toEqual([]);
  });

  it('🔴 警告に設定値や secret を載せない', async () => {
    const res = await put({
      provider: 'vonage',
      enabled: true,
      applicationId: 'TEST-app',
      fromNumber: '+81900001111',
    });
    const raw = await res.text();
    expect(JSON.parse(raw).warnings).toContain('real_dialing_without_secret');
    // 応答全体には fromNumber が（射影として）載るが、**警告の中**には載らない。
    expect(JSON.stringify(JSON.parse(raw).warnings)).not.toContain('81900001111');
  });
});
