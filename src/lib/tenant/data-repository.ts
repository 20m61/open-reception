/**
 * テナント基盤リポジトリの永続化実装 (issue #80, increment 3)。
 *
 * increment 1 の in-memory（MemoryTenantStore）に代わり、既存業務データと同じ流儀で
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する永続化を提供する。
 * admin-user-store.ts（inc2）の流儀に合わせ、コレクション単位で getBackend().collection を引く。
 *
 * repository interface（./repository.ts）は維持する。SiteService/DeviceService は interface に
 * のみ依存するため、本実装へ差し替えても既存サービスのテスト（memory backend）は緑のまま。
 *
 * テナント境界の強制（他テナントのデータを返さない）は、Collection.list() を tenantId/siteId で
 * フィルタすることで成立させる（admin-user-store の findBy 走査フォールバックと同じ扱い。
 * Tenant/Site/Device は小規模なため list 走査で足りる。PK/SK・GSI 最適化は将来増分）。
 * 認可判定そのものは呼び出し側（src/domain/tenant/authorization.ts）の責務（責務分離）。
 *
 * 永続化先非依存: DATA_BACKEND=memory なら in-memory Collection に、dynamodb なら DynamoDB に
 * そのまま載る。本増分はキー設計（PK=TENANT#... / SK=...）の最適化までは行わず、Collection
 * 抽象（id 単位）の上に素直に載せる（docs/multitenant-design.md §データ設計の残課題参照）。
 */
import {
  type AdminUser,
  type AdminUserId,
  type Device,
  type DeviceId,
  type Site,
  type SiteId,
  type Tenant,
  type TenantId,
} from '@/domain/tenant/types';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import { DataBackedAdminUserRepository } from './admin-user-store';
import type {
  AdminUserRepository,
  DeviceRepository,
  RepoResult,
  SiteRepository,
  TenantRepository,
  TenantStore,
} from './repository';

export const TENANT_COLLECTION = 'tenant';
export const SITE_COLLECTION = 'site';
export const DEVICE_COLLECTION = 'device';

export type TenantSeed = {
  tenants?: Tenant[];
  sites?: Site[];
  devices?: Device[];
};

/**
 * memory backend 専用 seed を Collection に渡すためのファクトリ束。
 * dynamodb では seed は無視される（CollectionOpts の契約どおり）。
 */
function collections(seed?: TenantSeed) {
  const backend = getBackend();
  return {
    tenants: backend.collection<Tenant>(TENANT_COLLECTION, {
      seed: seed?.tenants ? () => (seed.tenants ?? []).map((t) => ({ ...t })) : undefined,
    }),
    sites: backend.collection<Site>(SITE_COLLECTION, {
      seed: seed?.sites ? () => (seed.sites ?? []).map((s) => ({ ...s })) : undefined,
    }),
    devices: backend.collection<Device>(DEVICE_COLLECTION, {
      seed: seed?.devices ? () => (seed.devices ?? []).map((d) => ({ ...d })) : undefined,
    }),
  };
}

class DataBackedTenantRepository implements TenantRepository {
  constructor(private readonly col: () => Collection<Tenant>) {}

  async listTenants(): Promise<Tenant[]> {
    return this.col().list();
  }

  async getTenant(id: TenantId): Promise<Tenant | undefined> {
    return this.col().get(id);
  }

  async createTenant(tenant: Tenant): Promise<RepoResult<Tenant>> {
    const col = this.col();
    if (await col.get(tenant.id))
      return { ok: false, error: { code: 'conflict', message: 'tenant id exists' } };
    // slug 一意制約は走査で担保（小規模・GSI 化は将来増分）。
    const all = await col.list();
    if (all.some((t) => t.slug === tenant.slug))
      return { ok: false, error: { code: 'conflict', message: 'tenant slug exists' } };
    await col.put(tenant);
    return { ok: true, value: { ...tenant } };
  }

  async putTenant(tenant: Tenant): Promise<void> {
    await this.col().put(tenant);
  }
}

class DataBackedSiteRepository implements SiteRepository {
  constructor(private readonly col: () => Collection<Site>) {}

  async listSites(tenantId: TenantId): Promise<Site[]> {
    const all = await this.col().list();
    return all.filter((s) => s.tenantId === tenantId);
  }

  async getSite(tenantId: TenantId, id: SiteId): Promise<Site | undefined> {
    const s = await this.col().get(id);
    return s && s.tenantId === tenantId ? s : undefined;
  }

  async createSite(site: Site): Promise<RepoResult<Site>> {
    const col = this.col();
    if (await col.get(site.id))
      return { ok: false, error: { code: 'conflict', message: 'site id exists' } };
    await col.put(site);
    return { ok: true, value: { ...site } };
  }

  async putSite(site: Site): Promise<void> {
    await this.col().put(site);
  }
}

class DataBackedDeviceRepository implements DeviceRepository {
  constructor(private readonly col: () => Collection<Device>) {}

  async listDevices(tenantId: TenantId, siteId: SiteId): Promise<Device[]> {
    const all = await this.col().list();
    return all.filter((d) => d.tenantId === tenantId && d.siteId === siteId);
  }

  async getDevice(tenantId: TenantId, id: DeviceId): Promise<Device | undefined> {
    const d = await this.col().get(id);
    return d && d.tenantId === tenantId ? d : undefined;
  }

  async createDevice(device: Device): Promise<RepoResult<Device>> {
    const col = this.col();
    if (await col.get(device.id))
      return { ok: false, error: { code: 'conflict', message: 'device id exists' } };
    await col.put(device);
    return { ok: true, value: { ...device } };
  }

  async putDevice(device: Device): Promise<void> {
    await this.col().put(device);
  }
}

/**
 * getBackend() に永続化する TenantStore 実装。
 * adminUsers は inc2 の DataBackedAdminUserRepository（コレクション 'admin_user'）を再利用する。
 *
 * seed は memory backend のみ有効（dev/test/CI の単一テナント互換シード）。dynamodb では無視され、
 * 実データを正とする（CollectionOpts.seed の契約）。
 */
export class DataBackedTenantStore implements TenantStore {
  readonly tenants: TenantRepository;
  readonly sites: SiteRepository;
  readonly devices: DeviceRepository;
  readonly adminUsers: AdminUserRepository;

  constructor(seed?: TenantSeed) {
    // collection ハンドルは同一 name で共有されるため、毎回引いても同じ実体を指す。
    this.tenants = new DataBackedTenantRepository(() => collections(seed).tenants);
    this.sites = new DataBackedSiteRepository(() => collections(seed).sites);
    this.devices = new DataBackedDeviceRepository(() => collections(seed).devices);
    this.adminUsers = new DataBackedAdminUserRepositoryProxy();
  }
}

/**
 * AdminUser リポジトリは inc2 実装をそのまま委譲で再利用する（コレクション 'admin_user' を共有）。
 * TenantStore.adminUsers として束ねるための薄いプロキシ。
 */
class DataBackedAdminUserRepositoryProxy implements AdminUserRepository {
  private readonly impl = new DataBackedAdminUserRepository();
  getAdminUser(id: AdminUserId): Promise<AdminUser | undefined> {
    return this.impl.getAdminUser(id);
  }
  findBySubject(subject: string): Promise<AdminUser | undefined> {
    return this.impl.findBySubject(subject);
  }
  findByEmail(email: string): Promise<AdminUser | undefined> {
    return this.impl.findByEmail(email);
  }
  putAdminUser(user: AdminUser): Promise<void> {
    return this.impl.putAdminUser(user);
  }
}

/** テスト用: テナント系コレクションを seed 状態へ戻す（memory のみ実効）。 */
export async function resetTenantCollections(seed?: TenantSeed): Promise<void> {
  const cols = collections(seed);
  await cols.tenants.reset();
  await cols.sites.reset();
  await cols.devices.reset();
}
