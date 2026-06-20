/**
 * プラットフォーム運用コンソール API の認可境界テスト (issue #90, increment 1)。
 *
 * developer 専用エリアであることを検証する:
 *   - 未認証                  → 401
 *   - 認証済みだが非 developer → 403
 *   - developer               → 200（テナント横断 read）
 * 返却に機密値・PII が含まれないことも確認する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, asSiteId, type Tenant } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listTenants = vi.fn<() => Promise<Tenant[]>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { listTenants: () => listTenants() } }),
}));

import { GET as DASHBOARD } from './dashboard/route';
import { GET as TENANTS } from './tenants/route';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }],
  };
}
function siteManager(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'site_manager', tenantId: asTenantId('internal'), siteId: asSiteId('s1'), deviceId: null }],
  };
}

const SAMPLE: Tenant[] = [
  {
    id: asTenantId('internal'),
    name: '社内',
    slug: 'internal',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: asTenantId('acme'),
    name: 'ACME',
    slug: 'acme',
    status: 'suspended',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  listTenants.mockResolvedValue(SAMPLE);
});

describe.each([
  ['GET /api/platform/dashboard', DASHBOARD],
  ['GET /api/platform/tenants', TENANTS],
])('%s authorization', (_name, handler) => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await handler()).status).toBe(401);
  });

  it('403 for non-developer (tenant_admin)', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await handler()).status).toBe(403);
  });

  it('403 for non-developer (site_manager)', async () => {
    resolveAdminActor.mockResolvedValue(siteManager());
    expect((await handler()).status).toBe(403);
  });

  it('200 for developer', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await handler()).status).toBe(200);
  });
});

describe('GET /api/platform/dashboard payload', () => {
  it('returns fleet summary and pending operational metrics', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await DASHBOARD()).json();
    expect(body.fleet).toEqual({ total: 2, active: 1, suspended: 1 });
    expect(body.metrics.estimatedCost).toEqual({ status: 'pending' });
    expect(body.metrics.recentErrors).toEqual({ status: 'pending' });
  });
});

describe('GET /api/platform/tenants payload', () => {
  it('returns summary + rows without secrets/PII (only metadata keys)', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await TENANTS()).json();
    expect(body.summary).toEqual({ total: 2, active: 1, suspended: 1 });
    expect(body.tenants).toHaveLength(2);
    // 名前順ソート。
    expect(body.tenants.map((t: { name: string }) => t.name)).toEqual(['ACME', '社内']);
    for (const row of body.tenants) {
      expect(Object.keys(row).sort()).toEqual(['id', 'name', 'slug', 'status', 'updatedAt']);
    }
  });
});
