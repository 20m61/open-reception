import { describe, expect, it } from 'vitest';
import {
  asAdminUserId,
  asDeviceId,
  asSiteId,
  asTenantId,
  type AdminUser,
  type Device,
  type Site,
  type Tenant,
} from '@/domain/tenant/types';
import { MemoryTenantStore } from './memory-repository';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');
const D_1 = asDeviceId('device-1');

const now = '2026-06-20T00:00:00.000Z';

function tenant(id = T_A, slug = 'a'): Tenant {
  return { id, name: `Tenant ${id}`, slug, status: 'active', createdAt: now, updatedAt: now };
}
function site(id: ReturnType<typeof asSiteId>, tenantId = T_A): Site {
  return { id, tenantId, name: `Site ${id}`, status: 'active', createdAt: now, updatedAt: now };
}
function device(id: ReturnType<typeof asDeviceId>, tenantId = T_A, siteId = S_1): Device {
  return { id, tenantId, siteId, name: `Device ${id}`, status: 'active', createdAt: now, updatedAt: now };
}

describe('MemoryTenantStore.tenants (#80)', () => {
  it('作成・取得・一覧', async () => {
    const store = new MemoryTenantStore();
    const created = await store.tenants.createTenant(tenant());
    expect(created.ok).toBe(true);
    expect(await store.tenants.getTenant(T_A)).toMatchObject({ id: T_A });
    expect(await store.tenants.listTenants()).toHaveLength(1);
  });

  it('id 重複・slug 重複は conflict', async () => {
    const store = new MemoryTenantStore({ tenants: [tenant(T_A, 'a')] });
    const dupId = await store.tenants.createTenant(tenant(T_A, 'other'));
    expect(dupId.ok).toBe(false);
    const dupSlug = await store.tenants.createTenant(tenant(T_B, 'a'));
    expect(dupSlug.ok).toBe(false);
    if (!dupSlug.ok) expect(dupSlug.error.code).toBe('conflict');
  });

  it('返り値は防御コピー（外部変更が内部に波及しない）', async () => {
    const store = new MemoryTenantStore({ tenants: [tenant()] });
    const t = await store.tenants.getTenant(T_A);
    if (t) t.name = 'mutated';
    expect((await store.tenants.getTenant(T_A))?.name).not.toBe('mutated');
  });
});

describe('MemoryTenantStore.sites (#80 テナント境界)', () => {
  it('listSites は指定テナント配下のみ返す', async () => {
    const store = new MemoryTenantStore({
      sites: [site(S_1, T_A), site(S_2, T_B)],
    });
    const aSites = await store.sites.listSites(T_A);
    expect(aSites.map((s) => s.id)).toEqual([S_1]);
  });

  it('getSite は他テナントの id では取れない', async () => {
    const store = new MemoryTenantStore({ sites: [site(S_1, T_A)] });
    expect(await store.sites.getSite(T_A, S_1)).toBeDefined();
    expect(await store.sites.getSite(T_B, S_1)).toBeUndefined();
  });
});

describe('MemoryTenantStore.devices (#80 テナント境界)', () => {
  it('listDevices はテナント+サイト境界でフィルタ', async () => {
    const store = new MemoryTenantStore({
      devices: [device(D_1, T_A, S_1), device(asDeviceId('d2'), T_A, S_2), device(asDeviceId('d3'), T_B, S_1)],
    });
    const r = await store.devices.listDevices(T_A, S_1);
    expect(r.map((d) => d.id)).toEqual([D_1]);
  });

  it('getDevice は他テナントでは取れない', async () => {
    const store = new MemoryTenantStore({ devices: [device(D_1, T_A, S_1)] });
    expect(await store.devices.getDevice(T_B, D_1)).toBeUndefined();
  });
});

describe('MemoryTenantStore.adminUsers (#80)', () => {
  const user: AdminUser = {
    id: asAdminUserId('u1'),
    email: 'Admin@Example.com',
    displayName: 'Admin',
    assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  it('email は大文字小文字を無視して解決', async () => {
    const store = new MemoryTenantStore({ adminUsers: [user] });
    expect(await store.adminUsers.findByEmail('admin@example.com')).toMatchObject({ id: 'u1' });
    expect(await store.adminUsers.findByEmail('  ADMIN@EXAMPLE.COM ')).toMatchObject({ id: 'u1' });
    expect(await store.adminUsers.findByEmail('nope@example.com')).toBeUndefined();
  });

  it('putAdminUser で更新', async () => {
    const store = new MemoryTenantStore({ adminUsers: [user] });
    await store.adminUsers.putAdminUser({ ...user, displayName: 'Renamed' });
    expect((await store.adminUsers.getAdminUser(asAdminUserId('u1')))?.displayName).toBe('Renamed');
  });
});
