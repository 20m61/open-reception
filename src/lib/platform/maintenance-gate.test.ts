/**
 * kiosk メンテナンス enforcement ゲートのテスト (#290 item3)。
 *
 * kioskId（= Device.id）を Device レジストリで引いて tenant/site を得（device スコープは kioskId 自身）、
 * 登録済みメンテナンス一覧から現在有効なものを解決する。判定不能時は null（fail-open）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceWindow } from '@/domain/platform/maintenance-window';

const findDeviceById = vi.fn();
const listMaintenanceWindows = vi.fn<() => Promise<MaintenanceWindow[]>>();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById: (...a: unknown[]) => findDeviceById(...a) } }),
}));
vi.mock('./maintenance-window-store', () => ({
  listMaintenanceWindows: () => listMaintenanceWindows(),
}));

import { resolveKioskMaintenance } from './maintenance-gate';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const inWindow = { startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-01T16:00:00.000Z' };

const mw = (over: Partial<MaintenanceWindow> & Pick<MaintenanceWindow, 'id' | 'scope'>): MaintenanceWindow => ({
  status: 'active',
  message: 'メンテ中',
  impact: 'read_only',
  createdBy: 'platform:op',
  updatedAt: '2026-06-20T00:00:00.000Z',
  ...inWindow,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findDeviceById.mockResolvedValue(undefined);
  listMaintenanceWindows.mockResolvedValue([]);
});

describe('resolveKioskMaintenance (#290 item3)', () => {
  it('端末のテナントに影響するメンテを解決する', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-1', tenantId: 'acme', siteId: 'hq' });
    listMaintenanceWindows.mockResolvedValue([mw({ id: 't', scope: 'tenant', tenantId: 'acme', impact: 'unavailable' })]);
    const r = await resolveKioskMaintenance('kiosk-1', NOW);
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-1');
    expect(r).toEqual({ impact: 'unavailable', message: 'メンテ中', endsAt: inWindow.endsAt });
  });

  it('別テナントのメンテには影響されない', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-1', tenantId: 'acme', siteId: 'hq' });
    listMaintenanceWindows.mockResolvedValue([mw({ id: 't', scope: 'tenant', tenantId: 'other' })]);
    await expect(resolveKioskMaintenance('kiosk-1', NOW)).resolves.toBeNull();
  });

  it('device スコープは kioskId 自身に一致する', async () => {
    findDeviceById.mockResolvedValue(undefined); // テナント未解決でも device スコープは効く
    listMaintenanceWindows.mockResolvedValue([mw({ id: 'd', scope: 'device', deviceId: 'kiosk-1' })]);
    await expect(resolveKioskMaintenance('kiosk-1', NOW)).resolves.not.toBeNull();
  });

  it('platform スコープは端末未解決でも影響する', async () => {
    findDeviceById.mockResolvedValue(undefined);
    listMaintenanceWindows.mockResolvedValue([mw({ id: 'p', scope: 'platform', impact: 'limited' })]);
    await expect(resolveKioskMaintenance('kiosk-unknown', NOW)).resolves.toMatchObject({ impact: 'limited' });
  });

  it('空 kioskId はレジストリを引かず platform スコープのみ解決する', async () => {
    listMaintenanceWindows.mockResolvedValue([mw({ id: 'p', scope: 'platform' })]);
    const r = await resolveKioskMaintenance('   ', NOW);
    expect(findDeviceById).not.toHaveBeenCalled();
    expect(r).not.toBeNull();
  });

  it('ストア障害時は null（fail-open: メンテ判定不能で受付を止めない）', async () => {
    listMaintenanceWindows.mockRejectedValue(new Error('backend down'));
    await expect(resolveKioskMaintenance('kiosk-1', NOW)).resolves.toBeNull();
  });
});
