/**
 * PUT/DELETE /api/platform/integrations/provider-config/secret の blocking セキュリティ AC テスト (#405 Inc1)。
 *
 *   - AC1: secret の値が応答にも監査にも一切出ない（write-only・echo なし）。
 *   - AC4: tenantId は認可済みコンテキスト(cookie)由来のみ。body.tenantId で他テナントの参照名を組めない。
 *   - AC6: 期待 provider 名の一致（確認フィールド）不一致は 409。未認証 401 / 非 developer 403。
 *
 * 擬似 secret は `TEST-...`（実 secret 風文字列・gitleaks 対象を置かない, AC8）。
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

import { PUT as SET, DELETE as CLEAR } from './route';
import {
  __resetProviderConfigStore,
  putTenantProviderConfig,
} from '@/lib/platform/provider-config-store';
import { __resetTenantSecretStore, getTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import { secretRef } from '@/domain/provider-config/secret';

const FAKE = 'TEST-vonage-secret-do-not-leak-42';

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

function req(method: 'PUT' | 'DELETE', body: unknown) {
  return new Request('http://t/api/platform/integrations/provider-config/secret', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const setSecret = (body: unknown) => SET(req('PUT', body));
const clearSecret = (body: unknown) => CLEAR(req('DELETE', body));

beforeEach(async () => {
  vi.clearAllMocks();
  __resetProviderConfigStore();
  __resetTenantSecretStore();
  resolveAdminActor.mockResolvedValue(developer());
  getTenant.mockResolvedValue({ ...TENANT });
  cookieGet.mockReturnValue({ value: 'internal' });
  recordDangerAction.mockResolvedValue({});
  // secret を設定する前提として非秘密設定（provider=vonage）を用意する。
  await putTenantProviderConfig({
    tenantId: 'internal',
    provider: 'vonage',
    enabled: true,
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'platform:dev@example.com',
  });
});

describe('認可・前提 (#405 Inc1)', () => {
  it('未認証は 401 / 非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await setSecret({ secret: FAKE, expectedProvider: 'vonage' })).status).toBe(401);
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await setSecret({ secret: FAKE, expectedProvider: 'vonage' })).status).toBe(403);
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('config 未設定テナントは 409（先に非秘密設定が要る）', async () => {
    __resetProviderConfigStore();
    expect((await setSecret({ secret: FAKE, expectedProvider: 'vonage' })).status).toBe(409);
  });
});

describe('set secret — write-only (#405 Inc1 AC1)', () => {
  it('設定でき、応答は presence のみ・secret 値を echo しない', async () => {
    const res = await setSecret({ secret: FAKE, expectedProvider: 'vonage' });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ secretPresence: 'set' }));
    expect(text).not.toContain('TEST-');
    // ストアには実値が入る（内部）。
    expect(await getTenantSecretStore().hasSecret(secretRef('internal', 'vonage'))).toBe(true);
  });

  it('監査(secret.updated)に secret 値が一切現れない (AC1)', async () => {
    await setSecret({ secret: FAKE, expectedProvider: 'vonage' });
    expect(recordDangerAction).toHaveBeenCalledTimes(1);
    const arg = recordDangerAction.mock.calls[0]![0] as { action: string };
    expect(arg.action).toBe('secret.updated');
    expect(JSON.stringify(arg)).not.toContain('TEST-');
  });

  it('空の secret は 400 で、その値を echo しない', async () => {
    const res = await setSecret({ secret: '   ', expectedProvider: 'vonage' });
    expect(res.status).toBe(400);
    expect(await getTenantSecretStore().hasSecret(secretRef('internal', 'vonage'))).toBe(false);
  });
});

describe('確認フィールドによる誤操作防止 (#405 Inc1 AC6)', () => {
  it('期待 provider 名の不一致は 409（set/clear とも）', async () => {
    expect((await setSecret({ secret: FAKE, expectedProvider: 'mock' })).status).toBe(409);
    expect((await clearSecret({ expectedProvider: 'mock' })).status).toBe(409);
    expect(recordDangerAction).not.toHaveBeenCalled();
  });
});

describe('clear secret (#405 Inc1)', () => {
  it('消去でき、応答は presence missing・監査 secret.cleared', async () => {
    // route 経由で set → clear する。
    await setSecret({ secret: FAKE, expectedProvider: 'vonage' });
    vi.clearAllMocks();
    recordDangerAction.mockResolvedValue({});
    const res = await clearSecret({ expectedProvider: 'vonage' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secretPresence: 'missing' });
    expect(await getTenantSecretStore().hasSecret(secretRef('internal', 'vonage'))).toBe(false);
    const arg = recordDangerAction.mock.calls[0]![0] as { action: string };
    expect(arg.action).toBe('secret.cleared');
  });
});

describe('越境防止 (#405 Inc1 AC4)', () => {
  it('body.tenantId で他テナントの参照名を組み立てられない', async () => {
    // cookie=internal。body で acme を主張しても internal の参照名にしか書かれない。
    await setSecret({ secret: FAKE, expectedProvider: 'vonage', tenantId: 'acme' });
    expect(await getTenantSecretStore().hasSecret(secretRef('internal', 'vonage'))).toBe(true);
    expect(await getTenantSecretStore().hasSecret(secretRef('acme', 'vonage'))).toBe(false);
  });
});
