import { afterEach, describe, expect, it } from 'vitest';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type Device,
  type Site,
  type Tenant,
} from '@/domain/tenant/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedTenantStore, resetTenantCollections } from './data-repository';

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

afterEach(async () => {
  await resetTenantCollections();
  __resetBackend();
});

describe('DataBackedTenantStore.tenants (#80 inc3 永続化)', () => {
  it('作成→取得→一覧が round-trip する', async () => {
    const store = new DataBackedTenantStore();
    const created = await store.tenants.createTenant(tenant());
    expect(created.ok).toBe(true);
    expect(await store.tenants.getTenant(T_A)).toMatchObject({ id: T_A });
    expect(await store.tenants.listTenants()).toHaveLength(1);
  });

  it('id 重複・slug 重複は conflict', async () => {
    const store = new DataBackedTenantStore();
    await store.tenants.createTenant(tenant(T_A, 'a'));
    const dupId = await store.tenants.createTenant(tenant(T_A, 'other'));
    expect(dupId.ok).toBe(false);
    const dupSlug = await store.tenants.createTenant(tenant(T_B, 'a'));
    expect(dupSlug.ok).toBe(false);
    if (!dupSlug.ok) expect(dupSlug.error.code).toBe('conflict');
  });

  it('putTenant で更新が永続化される', async () => {
    const store = new DataBackedTenantStore();
    await store.tenants.createTenant(tenant());
    await store.tenants.putTenant({ ...tenant(), name: 'Renamed' });
    expect((await store.tenants.getTenant(T_A))?.name).toBe('Renamed');
  });

  it('返り値は防御コピー（外部変更が内部に波及しない）', async () => {
    const store = new DataBackedTenantStore();
    await store.tenants.createTenant(tenant());
    const t = await store.tenants.getTenant(T_A);
    if (t) t.name = 'mutated';
    expect((await store.tenants.getTenant(T_A))?.name).not.toBe('mutated');
  });

  it('seed は memory backend に投入される', async () => {
    const store = new DataBackedTenantStore({ tenants: [tenant(T_A, 'a'), tenant(T_B, 'b')] });
    expect(await store.tenants.listTenants()).toHaveLength(2);
  });
});

describe('DataBackedTenantStore.sites (#80 テナント境界)', () => {
  it('listSites は指定テナント配下のみ返す', async () => {
    const store = new DataBackedTenantStore();
    await store.sites.createSite(site(S_1, T_A));
    await store.sites.createSite(site(S_2, T_B));
    const aSites = await store.sites.listSites(T_A);
    expect(aSites.map((s) => s.id)).toEqual([S_1]);
  });

  it('getSite は他テナントの id では取れない', async () => {
    const store = new DataBackedTenantStore();
    await store.sites.createSite(site(S_1, T_A));
    expect(await store.sites.getSite(T_A, S_1)).toBeDefined();
    expect(await store.sites.getSite(T_B, S_1)).toBeUndefined();
  });
});

describe('DataBackedTenantStore.devices (#80 テナント境界)', () => {
  it('listDevices はテナント+サイト境界でフィルタ', async () => {
    const store = new DataBackedTenantStore();
    await store.devices.createDevice(device(D_1, T_A, S_1));
    await store.devices.createDevice(device(asDeviceId('d2'), T_A, S_2));
    await store.devices.createDevice(device(asDeviceId('d3'), T_B, S_1));
    const r = await store.devices.listDevices(T_A, S_1);
    expect(r.map((d) => d.id)).toEqual([D_1]);
  });

  it('getDevice は他テナントでは取れない', async () => {
    const store = new DataBackedTenantStore();
    await store.devices.createDevice(device(D_1, T_A, S_1));
    expect(await store.devices.getDevice(T_B, D_1)).toBeUndefined();
  });
});

describe('resetTenantCollections (#80 inc3 テスト導線)', () => {
  it('reset で seed 状態へ戻る', async () => {
    const store = new DataBackedTenantStore({ tenants: [tenant()] });
    await store.tenants.putTenant({ ...tenant(), name: 'changed' });
    await resetTenantCollections({ tenants: [tenant()] });
    expect((await store.tenants.getTenant(T_A))?.name).toBe(`Tenant ${T_A}`);
  });
});
