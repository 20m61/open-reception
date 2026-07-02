/**
 * 管理ダッシュボード集約 API のテスト (issue #86 / #261 / #284)。
 *
 * #261 の要点: 端末稼働は enabled フラグ（旧 summarizeDevices(listKiosks)）ではなく、
 * platform オブザーバビリティと **同一の共有関数**（kiosk/Device union の実 heartbeat 死活）
 * から供給される。surface 間で online 数が食い違わないこと（AC2）の dashboard 側配線を検証する。
 *
 * #284 item4 の要点: 実 actor を解決し、テナント境界付き actor には自テナントのみの
 * 死活集計（summarizeDeviceFleetForTenants）、developer には横断集計を供給する。
 * 未認証は 401、テナント割り当てゼロは 403。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FleetSummary } from '@/domain/tenant/device-liveness';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const listReceptionLogs = vi.fn();
const loadUsage = vi.fn();
const loadCostEstimate = vi.fn();
const summarizeDeviceFleet = vi.fn<() => Promise<FleetSummary>>();
const summarizeDeviceFleetForTenants = vi.fn<
  (tenantIds: readonly string[]) => Promise<FleetSummary>
>();
const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();

vi.mock('@/lib/data-stores/reception-log-store', () => ({
  listReceptionLogs: () => listReceptionLogs(),
}));
vi.mock('@/lib/usage/usage-data', () => ({
  loadUsage: () => loadUsage(),
  loadCostEstimate: () => loadCostEstimate(),
}));
vi.mock('@/lib/tenant/device-fleet', () => ({
  summarizeDeviceFleet: (...a: unknown[]) => summarizeDeviceFleet(...(a as [])),
  summarizeDeviceFleetForTenants: (tenantIds: readonly string[]) =>
    summarizeDeviceFleetForTenants(tenantIds),
}));
vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));

import { GET } from './route';

const FLEET: FleetSummary = { total: 3, online: 2, offline: 1, maintenance: 1, disabled: 2 };

function tenantAdmin(tenantId = 'internal'): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId(tenantId), siteId: null, deviceId: null }],
  };
}

function developer(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listReceptionLogs.mockResolvedValue([]);
  loadUsage.mockResolvedValue({ current: { receptions: 5 } });
  loadCostEstimate.mockResolvedValue({
    estimatedSoFar: 100,
    projectedMonthEnd: 300,
    currency: 'JPY',
  });
  summarizeDeviceFleet.mockResolvedValue(FLEET);
  summarizeDeviceFleetForTenants.mockResolvedValue(FLEET);
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

describe('GET /api/admin/dashboard (#284 実 actor 解決とテナント境界)', () => {
  it('未認証は 401（実 actor 解決）', async () => {
    resolveAdminActor.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listReceptionLogs).not.toHaveBeenCalled();
  });

  it('テナント境界付き actor には自テナントのみの死活集計を供給する', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin('t-a'));
    const body = await (await GET()).json();
    expect(summarizeDeviceFleetForTenants).toHaveBeenCalledTimes(1);
    expect(summarizeDeviceFleetForTenants).toHaveBeenCalledWith([asTenantId('t-a')]);
    expect(summarizeDeviceFleet).not.toHaveBeenCalled();
    expect(body.devices).toEqual(FLEET);
  });

  it('developer（全テナント横断）には横断集計（TTL キャッシュ共有）を供給する', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const body = await (await GET()).json();
    expect(summarizeDeviceFleet).toHaveBeenCalledTimes(1);
    expect(summarizeDeviceFleetForTenants).not.toHaveBeenCalled();
    expect(body.devices).toEqual(FLEET);
  });

  it('テナント割り当てゼロの actor は 403（境界を確定できないまま集計を返さない）', async () => {
    resolveAdminActor.mockResolvedValue({ status: 'active', assignments: [] });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(summarizeDeviceFleet).not.toHaveBeenCalled();
    expect(summarizeDeviceFleetForTenants).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/dashboard (#261 端末実死活)', () => {
  it('端末稼働は共有の実死活集計をそのまま返す', async () => {
    const body = await (await GET()).json();
    expect(summarizeDeviceFleetForTenants).toHaveBeenCalledTimes(1);
    expect(body.devices).toEqual(FLEET);
  });

  it('稼働可能端末が全台オフラインなら status=critical（実死活由来の異常検知）', async () => {
    summarizeDeviceFleetForTenants.mockResolvedValue({
      total: 2,
      online: 0,
      offline: 2,
      maintenance: 0,
      disabled: 0,
    });
    const body = await (await GET()).json();
    expect(body.status).toBe('critical');
  });

  it('利用量/コスト概況を含める（既存 #86 挙動の回帰確認）', async () => {
    const body = await (await GET()).json();
    expect(body.usageCost).toEqual({
      receptionsThisMonth: 5,
      estimatedSoFar: 100,
      projectedMonthEnd: 300,
      currency: 'JPY',
    });
  });
});
