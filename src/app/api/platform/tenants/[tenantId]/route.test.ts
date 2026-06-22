/**
 * テナント有効/停止 API（PATCH /api/platform/tenants/[tenantId]）のテスト (issue #90)。
 * developer 専用の破壊的操作であること・状態更新・監査（理由つき）を検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type Tenant } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const getTenant = vi.fn<(id: unknown) => Promise<Tenant | undefined>>();
const putTenant = vi.fn<(t: Tenant) => Promise<void>>();
const recordDangerAction =
  vi.fn<(input: { action: AuditAction; target: unknown; reason?: string; metadata?: unknown }) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: () => resolveAdminActor() }));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { getTenant: (id: unknown) => getTenant(id), putTenant: (t: Tenant) => putTenant(t) } }),
}));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i as never) }));

import { PATCH } from './route';

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

function patch(body: unknown, tenantId = 'internal') {
  const req = new Request('http://x/api/platform/tenants/internal', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ tenantId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTenant.mockResolvedValue({ ...TENANT });
});

describe('PATCH /api/platform/tenants/[tenantId] (#90)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await patch({ action: 'suspend' })).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await patch({ action: 'suspend' })).status).toBe(403);
  });

  it('不正な action は 400', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await patch({ action: 'delete' })).status).toBe(400);
    expect(putTenant).not.toHaveBeenCalled();
  });

  it('存在しないテナントは 404', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    getTenant.mockResolvedValue(undefined);
    expect((await patch({ action: 'suspend' })).status).toBe(404);
  });

  it('developer は停止でき、状態更新と監査（理由つき）が残る', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const res = await patch({ action: 'suspend', reason: '請求停止のため' });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.status).toBe('suspended');
    expect(putTenant).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' }));
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.suspended', reason: '請求停止のため' }),
    );
  });

  it('developer は有効化でき、監査が tenant.activated になる', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    getTenant.mockResolvedValue({ ...TENANT, status: 'suspended' });
    const res = await patch({ action: 'activate' });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.status).toBe('active');
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.activated' }),
    );
  });
});
