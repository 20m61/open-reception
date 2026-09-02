/**
 * kioskId → テナント/拠点の束縛解決のテスト (#419)。
 * 既存の `operating-policy/kiosk-gate.ts` などが「未解決なら既定スコープ」で fail-open するのに対し、
 * 構成配信は **fail-closed**（未解決・失効なら null）である点を固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findDeviceById = vi.fn();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById: (...a: unknown[]) => findDeviceById(...a) } }),
}));

import { deviceActorFor, resolveDeviceBinding } from './device-binding';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const ACTIVE_DEVICE = {
  id: 'kiosk-1',
  tenantId: 'tenant-a',
  siteId: 'site-1',
  name: 'iPad受付端末',
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
  findDeviceById.mockResolvedValue(ACTIVE_DEVICE);
});

describe('resolveDeviceBinding', () => {
  it('登録済み・有効な端末のテナント/拠点を返す', async () => {
    await expect(resolveDeviceBinding('kiosk-1')).resolves.toEqual({
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-1'),
      kioskId: 'kiosk-1',
    });
  });

  it('未登録の端末は null（既定スコープへ落とさない）', async () => {
    findDeviceById.mockResolvedValue(undefined);
    await expect(resolveDeviceBinding('kiosk-x')).resolves.toBeNull();
  });

  it('失効した端末は null', async () => {
    findDeviceById.mockResolvedValue({ ...ACTIVE_DEVICE, status: 'revoked' });
    await expect(resolveDeviceBinding('kiosk-1')).resolves.toBeNull();
  });

  it('kioskId が空なら台帳を引かずに null', async () => {
    await expect(resolveDeviceBinding('  ')).resolves.toBeNull();
    expect(findDeviceById).not.toHaveBeenCalled();
  });

  it('ストア障害でも既定スコープへ落とさず null', async () => {
    findDeviceById.mockRejectedValue(new Error('store down'));
    await expect(resolveDeviceBinding('kiosk-1')).resolves.toBeNull();
  });
});

describe('deviceActorFor', () => {
  it('端末の束縛から kiosk_device 割り当てだけを持つ actor を組む', () => {
    const actor = deviceActorFor({
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-1'),
      kioskId: 'kiosk-1',
    });

    expect(actor).toEqual({
      status: 'active',
      assignments: [
        {
          role: 'kiosk_device',
          tenantId: asTenantId('tenant-a'),
          siteId: asSiteId('site-1'),
          deviceId: 'kiosk-1',
        },
      ],
    });
  });
});
