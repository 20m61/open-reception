/**
 * resolveStayScope の kiosk→tenant/site 実写像テスト。
 *
 * kioskId（= Device.id）を Device レジストリ（findDeviceById）で解決し、その端末が属する
 * tenant/site を stay scope として返すこと、未登録 kiosk / 空入力は dev 既定へ
 * フォールバックすることを検証する。これによりマルチテナントで在館記録が端末の実 scope に
 * 収まる（従来は全 stay が dev-tenant/dev-site の暫定スタブへ落ちていた）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device, type DeviceId } from '@/domain/tenant/types';

const findDeviceById = vi.fn<(id: DeviceId) => Promise<Device | undefined>>();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    devices: { findDeviceById: (id: DeviceId) => findDeviceById(id) },
  }),
}));

import { resolveStayScope, DEV_STAY_TENANT_ID, DEV_STAY_SITE_ID } from './store';

const device = (id: string, over: Partial<Device> = {}): Device => ({
  id: asDeviceId(id),
  tenantId: asTenantId('internal'),
  siteId: asSiteId('default-site'),
  name: id,
  status: 'active',
  maintenance: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findDeviceById.mockResolvedValue(undefined);
});

describe('resolveStayScope（kiosk→tenant/site 実写像）', () => {
  it('登録済み端末はその端末の tenant/site を返す（クライアント入力に依らず越境しない）', async () => {
    findDeviceById.mockResolvedValue(
      device('kiosk-acme', { tenantId: asTenantId('acme'), siteId: asSiteId('acme-hq') }),
    );
    const scope = await resolveStayScope('kiosk-acme');
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-acme');
    expect(scope).toEqual({ tenantId: asTenantId('acme'), siteId: asSiteId('acme-hq') });
  });

  it('前後空白を除いて解決する', async () => {
    findDeviceById.mockResolvedValue(device('kiosk-dev'));
    const scope = await resolveStayScope('  kiosk-dev  ');
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-dev');
    expect(scope).toEqual({ tenantId: asTenantId('internal'), siteId: asSiteId('default-site') });
  });

  it('未登録 kiosk（旧レジストリのみ・未 adopt）は dev 既定 scope へフォールバックする', async () => {
    findDeviceById.mockResolvedValue(undefined);
    const scope = await resolveStayScope('kiosk-unknown');
    expect(scope).toEqual({ tenantId: DEV_STAY_TENANT_ID, siteId: DEV_STAY_SITE_ID });
  });

  it('空・空白のみの kioskId はレジストリを引かず dev 既定へフォールバックする', async () => {
    const scope = await resolveStayScope('   ');
    expect(findDeviceById).not.toHaveBeenCalled();
    expect(scope).toEqual({ tenantId: DEV_STAY_TENANT_ID, siteId: DEV_STAY_SITE_ID });
  });
});
