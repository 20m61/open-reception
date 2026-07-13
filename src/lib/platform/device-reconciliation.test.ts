/**
 * 端末レジストリ整合の read 側（planDeviceReconciliation）のテスト (#290 item2)。
 *
 * kiosk-store の全 kiosk と、テナント一覧起点 + テナント毎の境界クエリ（#284 恒久化・無境界の
 * listAllDevices を使わない）で集めた全 Device を突き合わせ、dry-run プランを返すことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device, type Tenant } from '@/domain/tenant/types';

const listKiosks = vi.fn();
const listTenants = vi.fn<() => Promise<Tenant[]>>();
const listDevicesByTenant = vi.fn<(t: string) => Promise<Device[]>>();

vi.mock('@/lib/kiosk/kiosk-store', () => ({ listKiosks: () => listKiosks() }));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    tenants: { listTenants: () => listTenants() },
    devices: { listDevicesByTenant: (t: string) => listDevicesByTenant(t) },
  }),
}));

import { planDeviceReconciliation } from './device-reconciliation';

const tenant = (id: string): Tenant => ({
  id: asTenantId(id),
  name: id,
  slug: id,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const device = (id: string, tenantId: string, status: Device['status'] = 'active'): Device => ({
  id: asDeviceId(id),
  tenantId: asTenantId(tenantId),
  siteId: asSiteId('site'),
  name: id,
  status,
  maintenance: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  listKiosks.mockResolvedValue([]);
  listTenants.mockResolvedValue([]);
  listDevicesByTenant.mockResolvedValue([]);
});

describe('planDeviceReconciliation (#290 item2)', () => {
  it('テナント横断で Device を集め kiosk と突き合わせる（境界クエリを各テナントで実行）', async () => {
    listKiosks.mockResolvedValue([
      { id: 'kiosk-a', displayName: 'A', enabled: true }, // acme に一致
      { id: 'kiosk-new', displayName: 'New', enabled: true }, // 未 adopt → adopt
    ]);
    listTenants.mockResolvedValue([tenant('acme'), tenant('globex')]);
    listDevicesByTenant.mockImplementation(async (t) =>
      t === 'acme' ? [device('kiosk-a', 'acme', 'active')] : [device('device-g', 'globex', 'active')],
    );

    const plan = await planDeviceReconciliation();

    expect(listDevicesByTenant).toHaveBeenCalledWith(asTenantId('acme'));
    expect(listDevicesByTenant).toHaveBeenCalledWith(asTenantId('globex'));
    expect(plan.kioskCount).toBe(2);
    expect(plan.deviceCount).toBe(2); // 2 テナントの union
    expect(plan.adopt.map((a) => a.id)).toEqual(['kiosk-new']);
    expect(plan.deviceOnly.map((d) => d.id)).toEqual(['device-g']);
    expect(plan.driftCount).toBe(1);
  });

  it('drift 無しは全空のプランを返す', async () => {
    listKiosks.mockResolvedValue([{ id: 'kiosk-a', displayName: 'A', enabled: true }]);
    listTenants.mockResolvedValue([tenant('acme')]);
    listDevicesByTenant.mockResolvedValue([device('kiosk-a', 'acme', 'active')]);

    const plan = await planDeviceReconciliation();
    expect(plan.driftCount).toBe(0);
    expect(plan.adopt).toEqual([]);
    expect(plan.syncStatus).toEqual([]);
    expect(plan.deviceOnly).toEqual([]);
  });
});
