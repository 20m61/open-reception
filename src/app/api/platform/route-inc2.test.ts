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
import { currentMonthPeriod } from '@/domain/usage/usage-summary';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listTenants = vi.fn<() => Promise<Tenant[]>>();
const getTenant = vi.fn<(id: string) => Promise<Tenant | undefined>>();
const listSites = vi.fn<(tenantId: string) => Promise<Site[]>>();
const listDevices = vi.fn<(tenantId: string, siteId: string) => Promise<Device[]>>();
const listDevicesByTenant = vi.fn<(tenantId: string) => Promise<Device[]>>();
const listAuditLogs = vi.fn<() => Promise<AuditLog[]>>();
const listReceptionLogsSince = vi.fn<() => Promise<unknown[]>>();
const listKiosks = vi.fn<() => Promise<unknown[]>>();
const listIntegrationStatuses = vi.fn<() => Promise<unknown[]>>();
const listAuthMethodStatuses = vi.fn();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  // 監査ログ閲覧・テナント詳細 read は identity 帰属の閲覧監査 (#83 §5 / inc5b) を残すため identity 付き解決を使う。
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
// read 系監査 (#83 §5 / inc5b) は本ファイルの関心外なので記録だけ吸収する
// （検証は audit-logs/route-view-audit.test.ts と tenants/[tenantId]/route.test.ts）。
vi.mock('@/lib/platform/read-audit', () => ({ recordPlatformReadAudit: async () => ({}) }));
// maintenance ルートは対象テナント選択 Cookie を読む（inc3b-2）。未選択（絞り込みなし）で返す。
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    tenants: { listTenants: () => listTenants(), getTenant: (id: string) => getTenant(id) },
    sites: { listSites: (t: string) => listSites(t) },
    devices: {
      listDevices: (t: string, s: string) => listDevices(t, s),
      listDevicesByTenant: (t: string) => listDevicesByTenant(t),
    },
  }),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  listAuditLogs: () => listAuditLogs(),
  listReceptionLogsSince: () => listReceptionLogsSince(),
}));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  listKiosks: () => listKiosks(),
}));
vi.mock('@/lib/security/integration-status-store', () => ({
  listIntegrationStatuses: () => listIntegrationStatuses(),
  listAuthMethodStatuses: () => listAuthMethodStatuses(),
}));
vi.mock('@/lib/call/vonage-config', () => ({
  isVonageConfigured: () => true,
  isVonageEnabled: () => false,
}));

import { __resetDeviceFleetCache } from '@/lib/tenant/device-fleet';
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
  // 端末死活は TTL キャッシュ越しに集計されるため、テスト間の持ち越しを防ぐ (#261)。
  __resetDeviceFleetCache();
  listTenants.mockResolvedValue([TENANT]);
  getTenant.mockResolvedValue(TENANT);
  listSites.mockResolvedValue(SITES);
  listDevices.mockResolvedValue(DEVICES);
  listDevicesByTenant.mockResolvedValue([]);
  listAuditLogs.mockResolvedValue(AUDIT);
  listReceptionLogsSince.mockResolvedValue([]);
  listKiosks.mockResolvedValue([]);
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

  it('observability は受付成功率・端末の実死活を実接続する（#83 / #261）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const period = currentMonthPeriod();
    listReceptionLogsSince.mockResolvedValue([
      { id: 'r1', outcome: 'connected', startedAt: period.start, fallbackUsed: false, durationMs: 1000 },
      { id: 'r2', outcome: 'failed', startedAt: period.start, fallbackUsed: false, durationMs: 0 },
    ]);
    const dev = (over: Partial<Device>): Device => ({
      id: asDeviceId('x'),
      tenantId: asTenantId('internal'),
      siteId: asSiteId('s1'),
      name: 'd',
      status: 'active',
      maintenance: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });
    // 実死活は kiosk/Device 両レジストリの union (#261 AC1)。id 一致（kiosk-dev）は Device 優先。
    listKiosks.mockResolvedValue([
      { id: 'kiosk-dev', displayName: '対応済', enabled: true }, // Device 側の heartbeat を採用
      { id: 'kiosk-legacy', displayName: '旧のみ', enabled: true }, // kiosk のみ → offline
      { id: 'kiosk-gone', displayName: '失効', enabled: false }, // kiosk のみ失効 → disabled
    ]);
    // 横断集計はテナント一覧起点の境界クエリ（#274/#284。listTenants は beforeEach で TENANT=internal）。
    listDevicesByTenant.mockResolvedValue([
      dev({ id: asDeviceId('kiosk-dev'), lastSeenAt: new Date().toISOString() }), // online
      dev({ id: asDeviceId('mnt'), maintenance: true }), // maintenance（別掲）
      dev({ id: asDeviceId('dis'), status: 'revoked' }), // disabled（別掲）
    ]);
    const body = await (await OBSERVABILITY()).json();
    expect(body.reception.receptions).toBe(2);
    expect(body.reception.successRate).toBeCloseTo(0.5); // connected 1 / 通話試行 2
    expect(body.reception.callFailures).toBe(1);
    // 分母（total）は稼働可能端末のみ（online 1 + offline 1）。maintenance/disabled は別掲 (#261 AC4)。
    expect(body.devices).toEqual({ total: 2, online: 1, offline: 1, maintenance: 1, disabled: 2 });
  });
});
