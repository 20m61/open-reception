/**
 * PUT /api/platform/selected-tenant — 対象テナント切替のテスト (issue #83 §5 / inc5b)。
 *
 * TenantSwitcher の適用をサーバ側 API に通し、切替を確実に監査
 * （platform.tenant_scope.switched）へ残すことを検証する。Cookie 値は選択テナント id のみ
 * （PII・機微値なし）。存在しないテナントへの切替は拒否する（#268 スコープ実在チェックの型）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type Tenant } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const getTenant = vi.fn<(id: unknown) => Promise<Tenant | undefined>>();
const recordPlatformReadAudit = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { getTenant: (id: unknown) => getTenant(id) } }),
}));
vi.mock('@/lib/platform/read-audit', () => ({
  recordPlatformReadAudit: (i: unknown) => recordPlatformReadAudit(i),
}));

import { PUT } from './route';
import { SELECTED_TENANT_COOKIE } from '@/lib/platform/selected-tenant';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }] };
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
    new Request('http://t/api/platform/selected-tenant', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAdminActor.mockResolvedValue(developer());
  getTenant.mockResolvedValue({ ...TENANT });
  recordPlatformReadAudit.mockResolvedValue({});
});

describe('PUT /api/platform/selected-tenant (#83 §5 対象テナント切替)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await put({ tenantId: 'internal' })).status).toBe(401);
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await put({ tenantId: 'internal' })).status).toBe(403);
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('tenantId が string/null 以外は 400', async () => {
    expect((await put({ tenantId: 123 })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('存在しないテナントへの切替は 404（Cookie も監査も残さない）', async () => {
    getTenant.mockResolvedValue(undefined);
    const res = await put({ tenantId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.cookies.get(SELECTED_TENANT_COOKIE)).toBeUndefined();
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('切替成功: Cookie に id を設定し、切替を監査に残す（actor 帰属・対象明示）', async () => {
    const res = await put({ tenantId: 'internal' });
    expect(res.status).toBe(200);
    expect((await res.json()).tenantId).toBe('internal');
    expect(res.cookies.get(SELECTED_TENANT_COOKIE)?.value).toBe('internal');
    expect(recordPlatformReadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.tenant_scope.switched',
        identity: 'dev@example.com',
        target: { type: 'tenant', id: 'internal' },
        request: expect.any(Request),
      }),
    );
  });

  it('全テナント横断へ戻す（tenantId: null）: Cookie を空にし、scope:all を監査に残す', async () => {
    const res = await put({ tenantId: null });
    expect(res.status).toBe(200);
    expect((await res.json()).tenantId).toBeNull();
    expect(res.cookies.get(SELECTED_TENANT_COOKIE)?.value).toBe('');
    expect(recordPlatformReadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.tenant_scope.switched',
        target: { type: 'platform' },
        metadata: expect.objectContaining({ scope: 'all' }),
      }),
    );
  });

  it('監査の記録に失敗したら 500（未監査の切替を成立させない・audit-first）', async () => {
    recordPlatformReadAudit.mockRejectedValue(new Error('store down'));
    const res = await put({ tenantId: 'internal' });
    expect(res.status).toBe(500);
    expect(res.cookies.get(SELECTED_TENANT_COOKIE)).toBeUndefined();
  });
});
