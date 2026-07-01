/**
 * テナント有効/停止 API（PATCH /api/platform/tenants/[tenantId]）のテスト (issue #90)。
 * developer 専用の破壊的操作であること・状態更新・監査（理由つき）を検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type Tenant } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const getTenant = vi.fn<(id: unknown) => Promise<Tenant | undefined>>();
const putTenant = vi.fn<(t: Tenant) => Promise<void>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const recordDangerAction =
  vi.fn<
    (input: {
      action: AuditAction;
      target: unknown;
      reason?: string;
      metadata?: unknown;
      before?: unknown;
      after?: unknown;
      request?: Request;
    }) => Promise<unknown>
  >();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { getTenant: (id: unknown) => getTenant(id), putTenant: (t: Tenant) => putTenant(t) } }),
}));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i as never) }));

import { PATCH } from './route';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

/** developer に platform 全体の有効な昇格 cookie を持たせる。 */
async function grantCookie(): Promise<void> {
  const token = await issueElevationToken(grantElevation({ reason: 'テナント運用のため', scope: {} }, Date.now()), 'j', 'dev@example.com');
  cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
}

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
  cookieGet.mockReturnValue(undefined); // 既定: 未昇格。
});

describe('PATCH /api/platform/tenants/[tenantId] (#90 / JIT #83 AC5)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await patch({ action: 'suspend' })).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await patch({ action: 'suspend' })).status).toBe(403);
  });

  it('developer でも未昇格は 403 elevation_required（破壊的操作は JIT 昇格必須）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const res = await patch({ action: 'suspend', reason: 'x' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('elevation_required');
    expect(putTenant).not.toHaveBeenCalled();
  });

  it('不正な action は 400（昇格済み）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    expect((await patch({ action: 'delete' })).status).toBe(400);
    expect(putTenant).not.toHaveBeenCalled();
  });

  it('存在しないテナントは 404（昇格済み）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    getTenant.mockResolvedValue(undefined);
    expect((await patch({ action: 'suspend' })).status).toBe(404);
  });

  it('昇格済み developer は停止でき、状態更新と監査（理由つき）が残る', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    const res = await patch({ action: 'suspend', reason: '請求停止のため' });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.status).toBe('suspended');
    expect(putTenant).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' }));
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.suspended',
        reason: '請求停止のため',
        // 高詳細監査 (#83 AC13): status の before/after と操作元リクエストを渡す。
        before: { status: 'active' },
        after: { status: 'suspended' },
        request: expect.any(Request),
      }),
    );
  });

  it('昇格済み developer は有効化でき、監査が tenant.activated になる', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    getTenant.mockResolvedValue({ ...TENANT, status: 'suspended' });
    const res = await patch({ action: 'activate' });
    expect(res.status).toBe(200);
    expect((await res.json()).tenant.status).toBe('active');
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.activated' }),
    );
  });
});
