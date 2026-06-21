/**
 * プラットフォーム運用コンソール API（increment 2）の認可境界・payload テスト (issue #90)。
 *
 * 追加 read API（テナント詳細・機能フラグ・可観測性・メンテナンス・監査ログ）が
 * developer 専用であること（未認証 401 / 非 developer 403 / developer 200）と、
 * 返却に機密値・PII を含めない（マスク済み・メタ情報のみ）ことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type Device,
  type Site,
  type Tenant,
} from '@/domain/tenant/types';
import type { AuditLog } from '@/domain/reception/log';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listTenants = vi.fn<() => Promise<Tenant[]>>();
const getTenant = vi.fn<(id: string) => Promise<Tenant | undefined>>();
const listSites = vi.fn<(tenantId: string) => Promise<Site[]>>();
const listDevices = vi.fn<(tenantId: string, siteId: string) => Promise<Device[]>>();
const listAuditLogs = vi.fn<() => Promise<AuditLog[]>>();
const listIntegrationStatuses = vi.fn<() => Promise<unknown[]>>();
const listAuthMethodStatuses = vi.fn();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    tenants: { listTenants: () => listTenants(), getTenant: (id: string) => getTenant(id) },
    sites: { listSites: (t: string) => listSites(t) },
    devices: { listDevices: (t: string, s: string) => listDevices(t, s) },
  }),
}));
vi.mock('@/lib/mock-backend/reception-log-store', () => ({
  listAuditLogs: () => listAuditLogs(),
}));
vi.mock('@/lib/security/integration-status-store', () => ({
  listIntegrationStatuses: () => listIntegrationStatuses(),
  listAuthMethodStatuses: () => listAuthMethodStatuses(),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  isVonageConfigured: () => true,
  isVonageEnabled: () => false,
}));

import { GET as TENANT_DETAIL } from './tenants/[tenantId]/route';
import { GET as FEATURE_FLAGS } from './feature-flags/route';
import { GET as OBSERVABILITY } from './observability/route';
import { GET as MAINTENANCE } from './maintenance/route';
import { GET as AUDIT_LOGS } from './audit-logs/route';

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
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const SITES: Site[] = [
  {
    id: asSiteId('s1'),
    tenantId: asTenantId('internal'),
    name: '本社受付',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const DEVICES: Device[] = [
  {
    id: asDeviceId('d1'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('s1'),
    name: '受付端末1',
    status: 'active',
    maintenance: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const AUDIT: AuditLog[] = [
  {
    id: 'a1',
    action: 'reception.connected',
    actor: 'kiosk:dev-1',
    targetType: 'reception',
    targetId: 'r1',
    at: '2026-06-01T00:00:00.000Z',
    metadata: { failureReason: 'x' },
  },
];

const detailReq = () => new Request('http://t/api/platform/tenants/internal');
const detailCtx = { params: Promise.resolve({ tenantId: 'internal' }) };

beforeEach(() => {
  vi.clearAllMocks();
  listTenants.mockResolvedValue([TENANT]);
  getTenant.mockResolvedValue(TENANT);
  listSites.mockResolvedValue(SITES);
  listDevices.mockResolvedValue(DEVICES);
  listAuditLogs.mockResolvedValue(AUDIT);
  listIntegrationStatuses.mockResolvedValue([
    { id: 'vonage', label: 'Vonage', configured: true, enabled: false, lastResult: 'untested' },
  ]);
  listAuthMethodStatuses.mockReturnValue([{ id: 'password', label: 'pw', enabled: true, issues: [] }]);
});

describe.each([
  ['feature-flags', FEATURE_FLAGS],
  ['observability', OBSERVABILITY],
  ['maintenance', MAINTENANCE],
  ['audit-logs', AUDIT_LOGS],
])('GET /api/platform/%s authorization', (_name, handler) => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await handler()).status).toBe(401);
  });
  it('403 for non-developer', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await handler()).status).toBe(403);
  });
  it('200 for developer', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await handler()).status).toBe(200);
  });
});

describe('GET /api/platform/tenants/[tenantId] authorization', () => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await TENANT_DETAIL(detailReq(), detailCtx)).status).toBe(401);
  });
  it('403 for non-developer', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await TENANT_DETAIL(detailReq(), detailCtx)).status).toBe(403);
  });
  it('404 when tenant not found', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    getTenant.mockResolvedValue(undefined);
    expect((await TENANT_DETAIL(detailReq(), detailCtx)).status).toBe(404);
  });
  it('200 with aggregated detail for developer', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await TENANT_DETAIL(detailReq(), detailCtx)).json();
    expect(body.detail).toMatchObject({
      id: 'internal',
      siteCount: 1,
      deviceCount: 1,
      activeDeviceCount: 1,
      maintenanceDeviceCount: 1,
    });
  });
});

describe('payload safety (no PII / masked)', () => {
  beforeEach(() => resolveAdminActor.mockResolvedValue(developer()));

  it('audit-logs masks actor and omits metadata', async () => {
    const body = await (await AUDIT_LOGS()).json();
    expect(body.logs[0].actor).toBe('kiosk:***');
    expect('metadata' in body.logs[0]).toBe(false);
  });

  it('maintenance returns only maintenance devices', async () => {
    const body = await (await MAINTENANCE()).json();
    expect(body.summary.devicesInMaintenance).toBe(1);
    expect(body.summary.devices[0].deviceName).toBe('受付端末1');
  });

  it('feature-flags reports vonage state and pending limits without secrets', async () => {
    const body = await (await FEATURE_FLAGS()).json();
    expect(body.flags.vonage).toEqual({ configured: true, enabled: false });
    expect(body.limits.estimatedCost).toEqual({ status: 'pending' });
  });

  it('observability returns integrations + masked recent activity + pending metrics', async () => {
    const body = await (await OBSERVABILITY()).json();
    expect(body.integrations).toHaveLength(1);
    expect(body.recentActivity[0].actor).toBe('kiosk:***');
    expect(body.metrics.latency).toEqual({ status: 'pending' });
  });
});
