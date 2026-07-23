import { beforeEach, describe, expect, it, vi } from 'vitest';

const findDeviceById = vi.fn();
const resolveKioskStatusFor = vi.fn();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById: (...a: unknown[]) => findDeviceById(...a) } }),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => ({ tenantId: 'internal', siteId: 'default-site' }),
}));
vi.mock('./store', () => ({
  resolveKioskStatusFor: (...a: unknown[]) => resolveKioskStatusFor(...a),
}));

import { resolveKioskOperatingStatusById } from './kiosk-gate';

beforeEach(() => {
  vi.clearAllMocks();
  resolveKioskStatusFor.mockResolvedValue({ state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' });
});

describe('resolveKioskOperatingStatusById', () => {
  it('登録済み Device が見つかればその tenant/site で解決する', async () => {
    findDeviceById.mockResolvedValue({ tenantId: 't1', siteId: 's1' });
    const result = await resolveKioskOperatingStatusById('kiosk-1');
    expect(result).toEqual({ state: 'closed', reopenAt: '2026-07-23T00:00:00.000Z' });
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('t1', 's1', expect.any(Number));
  });

  it('Device 未登録は既定スコープ（resolveDefaultScope）へフォールバックする', async () => {
    findDeviceById.mockResolvedValue(undefined);
    await resolveKioskOperatingStatusById('kiosk-dev');
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('internal', 'default-site', expect.any(Number));
  });

  it('kioskId 未指定（空文字）も既定スコープへ倒す', async () => {
    await resolveKioskOperatingStatusById('');
    expect(findDeviceById).not.toHaveBeenCalled();
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('internal', 'default-site', expect.any(Number));
  });

  it('Device 解決が例外でも fail-open（既定スコープへフォールバック）', async () => {
    findDeviceById.mockRejectedValue(new Error('boom'));
    await resolveKioskOperatingStatusById('kiosk-1');
    expect(resolveKioskStatusFor).toHaveBeenCalledWith('internal', 'default-site', expect.any(Number));
  });

  it('resolveKioskStatusFor 自体が例外でも fail-open（undefined）', async () => {
    findDeviceById.mockResolvedValue({ tenantId: 't1', siteId: 's1' });
    resolveKioskStatusFor.mockRejectedValue(new Error('boom'));
    await expect(resolveKioskOperatingStatusById('kiosk-1')).resolves.toBeUndefined();
  });
});
