/**
 * プラットフォーム運用コンソール API（increment 3）の認可境界・payload テスト (issue #90 / #83)。
 *
 * 追加 read API（外部連携状態 /api/platform/integrations）が developer 専用であること
 * （未認証 401 / 非 developer 403 / developer 200）と、返却に機密値を含めない
 * （登録状態・接続結果・最終日時のみ／whitelist 済み）ことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';
import type { Incident } from '@/domain/platform/incident';
import type { MaintenanceWindow } from '@/domain/platform/maintenance-window';
import type { Notice } from '@/domain/platform/notice';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listIntegrationStatuses = vi.fn<() => Promise<unknown[]>>();
const listAuthMethodStatuses = vi.fn();
const listTenants = vi.fn<() => Promise<unknown[]>>();
const listIncidents = vi.fn<() => Promise<Incident[]>>();
const listMaintenanceWindows = vi.fn<() => Promise<MaintenanceWindow[]>>();
const listNotices = vi.fn<() => Promise<Notice[]>>();
/** 対象テナント選択 Cookie（or_platform_tenant）の値。null で未選択。 */
let selectedTenantCookie: string | null = null;

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'or_platform_tenant' && selectedTenantCookie
          ? { value: selectedTenantCookie }
          : undefined,
    }),
}));
vi.mock('@/lib/security/integration-status-store', () => ({
  listIntegrationStatuses: () => listIntegrationStatuses(),
  listAuthMethodStatuses: () => listAuthMethodStatuses(),
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    tenants: { listTenants: () => listTenants() },
    sites: { listSites: () => Promise.resolve([]) },
    devices: { listDevices: () => Promise.resolve([]) },
  }),
}));
vi.mock('@/lib/platform/incident-store', () => ({
  listIncidents: () => listIncidents(),
}));
vi.mock('@/lib/platform/maintenance-window-store', () => ({
  listMaintenanceWindows: () => listMaintenanceWindows(),
}));
vi.mock('@/lib/platform/notice-store', () => ({
  listNotices: () => listNotices(),
}));

import { GET as INTEGRATIONS } from './integrations/route';
import { GET as MAINTENANCE } from './maintenance/route';

function developer(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
  };
}
function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [
      { role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listIntegrationStatuses.mockResolvedValue([
    {
      id: 'vonage',
      label: 'Vonage',
      configured: true,
      enabled: false,
      lastResult: 'failure',
      lastFailureAt: '2026-06-01T00:00:00.000Z',
      lastErrorSummary: 'auth failed',
      // 機密が将来混入しても漏れないことを射影の whitelist が担保する（テストで確認）。
      apiSecret: 'SHOULD-NOT-LEAK',
    },
  ]);
  listAuthMethodStatuses.mockReturnValue([
    { id: 'entra', label: 'Entra ID', enabled: true, issues: [] },
    { id: 'password', label: '共有パスワード', enabled: false, issues: ['未設定'] },
  ]);
  listTenants.mockResolvedValue([]);
  listIncidents.mockResolvedValue([
    {
      id: 'i1',
      scope: 'platform',
      severity: 'major',
      status: 'monitoring',
      title: '障害A',
      message: 'm',
      startedAt: '2026-06-05T00:00:00.000Z',
      updatedBy: 'platform:secret-op',
    },
    {
      id: 'i2',
      scope: 'tenant',
      tenantId: 'internal',
      severity: 'minor',
      status: 'resolved',
      title: '障害B',
      message: 'm',
      startedAt: '2026-06-01T00:00:00.000Z',
      resolvedAt: '2026-06-01T01:00:00.000Z',
      updatedBy: 'platform:secret-op',
    },
  ]);
  listMaintenanceWindows.mockResolvedValue([
    {
      id: 'w1',
      scope: 'platform',
      status: 'scheduled',
      startsAt: '2026-07-01T15:00:00.000Z',
      endsAt: '2026-07-01T16:00:00.000Z',
      message: '定期メンテ',
      impact: 'read_only',
      createdBy: 'platform:secret-op',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
    {
      id: 'w2',
      scope: 'tenant',
      tenantId: 'internal',
      status: 'scheduled',
      startsAt: '2026-07-02T15:00:00.000Z',
      endsAt: '2026-07-02T16:00:00.000Z',
      message: 'テナント個別メンテ',
      impact: 'limited',
      createdBy: 'platform:secret-op',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
  ]);
  listNotices.mockResolvedValue([
    {
      id: 'n1',
      scope: 'platform',
      level: 'info',
      status: 'published',
      title: '全体お知らせ',
      body: 'b',
      publishedAt: '2026-06-20T00:00:00.000Z',
      createdBy: 'platform:secret-op',
      updatedAt: '2026-06-20T00:00:00.000Z',
    },
    {
      id: 'n2',
      scope: 'tenant',
      tenantId: 'internal',
      level: 'warning',
      status: 'archived',
      title: 'テナント告知',
      body: 'b',
      publishedAt: '2026-06-18T00:00:00.000Z',
      createdBy: 'platform:secret-op',
      updatedAt: '2026-06-19T00:00:00.000Z',
    },
  ]);
  selectedTenantCookie = null;
});

describe('GET /api/platform/integrations authorization', () => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await INTEGRATIONS()).status).toBe(401);
  });
  it('403 for non-developer', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await INTEGRATIONS()).status).toBe(403);
  });
  it('200 for developer', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await INTEGRATIONS()).status).toBe(200);
  });
});

describe('GET /api/platform/integrations payload safety', () => {
  beforeEach(() => resolveAdminActor.mockResolvedValue(developer()));

  it('returns integrations + authMethods without secrets', async () => {
    const body = await (await INTEGRATIONS()).json();
    expect(body.integrations).toHaveLength(1);
    const row = body.integrations[0];
    expect(row).toMatchObject({ id: 'vonage', label: 'Vonage', configured: true, enabled: false });
    expect(row.lastResult).toBe('failure');
    // whitelist 射影なので想定外フィールド（機密含む）は載らない。
    expect('apiSecret' in row).toBe(false);
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-LEAK');
  });

  it('returns auth methods sorted by label with issues', async () => {
    const body = await (await INTEGRATIONS()).json();
    expect(body.authMethods.map((m: { id: string }) => m.id)).toEqual(['entra', 'password']);
    expect(body.authMethods[1].issues).toEqual(['未設定']);
  });
});

describe('GET /api/platform/maintenance incidents (inc3e)', () => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await MAINTENANCE()).status).toBe(401);
  });

  it('403 for non-developer', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await MAINTENANCE()).status).toBe(403);
  });

  it('includes incident summary (active first) without operator identity', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await MAINTENANCE()).json();
    expect(body.incidents.activeCount).toBe(1);
    expect(body.incidents.totalCount).toBe(2);
    // 進行中(major monitoring)が先頭、resolved は後。
    expect(body.incidents.incidents[0].id).toBe('i1');
    expect(body.incidents.incidents[0].active).toBe(true);
    // 操作者識別子は載せない。
    expect('updatedBy' in body.incidents.incidents[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret-op');
  });

  it('includes maintenance window summary without operator identity', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await MAINTENANCE()).json();
    expect(body.windows.scheduledCount).toBe(2);
    expect(body.windows.totalCount).toBe(2);
    expect('createdBy' in body.windows.windows[0]).toBe(false);
  });

  it('includes notice summary (published first) without operator identity', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await MAINTENANCE()).json();
    expect(body.notices.activeCount).toBe(1);
    expect(body.notices.totalCount).toBe(2);
    expect(body.notices.notices[0].id).toBe('n1'); // published が先頭
    expect('createdBy' in body.notices.notices[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('secret-op');
  });
});

describe('GET /api/platform/maintenance tenant scope narrowing (inc3b-2)', () => {
  beforeEach(() => resolveAdminActor.mockResolvedValue(developer()));

  it('未選択は全件（platform + 全テナント）', async () => {
    selectedTenantCookie = null;
    const body = await (await MAINTENANCE()).json();
    expect(body.incidents.totalCount).toBe(2);
    expect(body.windows.totalCount).toBe(2);
    expect(body.notices.totalCount).toBe(2);
  });

  it('選択テナントは platform + 当該テナントのみに絞る', async () => {
    selectedTenantCookie = 'internal';
    const body = await (await MAINTENANCE()).json();
    // incidents: i1(platform) + i2(tenant=internal) = 2
    expect(body.incidents.incidents.map((i: { id: string }) => i.id).sort()).toEqual(['i1', 'i2']);
    // windows: w1(platform) + w2(tenant=internal) = 2
    expect(body.windows.windows.map((w: { id: string }) => w.id).sort()).toEqual(['w1', 'w2']);
    // notices: n1(platform) + n2(tenant=internal) = 2
    expect(body.notices.notices.map((n: { id: string }) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('無関係テナント選択時は platform スコープのみ残る', async () => {
    selectedTenantCookie = 'other-tenant';
    const body = await (await MAINTENANCE()).json();
    expect(body.incidents.incidents.map((i: { id: string }) => i.id)).toEqual(['i1']);
    expect(body.windows.windows.map((w: { id: string }) => w.id)).toEqual(['w1']);
    expect(body.notices.notices.map((n: { id: string }) => n.id)).toEqual(['n1']);
  });
});
