import { describe, it, expect, vi, beforeEach } from 'vitest';

const findDeviceById = vi.fn();
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById: (...a: unknown[]) => findDeviceById(...a) } }),
}));

import { resolveKioskScope } from './kiosk-scope';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveKioskScope', () => {
  it('resolves tenantId/siteId from the registered device for a known kioskId', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-1', tenantId: 'tenant-a', siteId: 'site-a' });
    const scope = await resolveKioskScope('kiosk-1');
    expect(scope).toEqual({ tenantId: 'tenant-a', siteId: 'site-a' });
  });

  it('falls back to the default scope for an unregistered kioskId (dev/back-compat)', async () => {
    findDeviceById.mockResolvedValue(undefined);
    const scope = await resolveKioskScope('unknown-kiosk');
    expect(scope).toEqual({ tenantId: 'internal', siteId: 'default-site' });
  });

  it('propagates a device-store failure instead of silently defaulting — tenant/site are a security boundary here (unlike feature-flag-gate, which is deliberately fail-open for a non-security switch), so an outage must not risk issuing a token with a wrong tenant scope', async () => {
    findDeviceById.mockRejectedValue(new Error('store unavailable'));
    await expect(resolveKioskScope('kiosk-1')).rejects.toThrow();
  });
});
