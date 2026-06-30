/**
 * テナント基盤リポジトリの in-memory 実装 (issue #80, increment 1)。
 *
 * 単体テストと dev/CI 用。プロセス内 Map で保持する。
 * 本番（DynamoDB シングルテーブル）実装は次増分。getBackend() への接続もそこで行う
 * （docs/multitenant-design.md §increment 計画 / §データ設計）。
 *
 * テナント境界の強制（他テナントのデータを返さない）はクエリ引数の tenantId/siteId で
 * フィルタすることで成立させる。認可判定そのものは呼び出し側
 * （src/domain/tenant/authorization.ts）の責務。
 */
import type {
  AdminUser,
  AdminUserId,
  Device,
  DeviceId,
  Site,
  SiteId,
  Tenant,
  TenantId,
} from '@/domain/tenant/types';
import type {
  AdminUserRepository,
  DeviceRepository,
  RepoResult,
  SiteRepository,
  TenantRepository,
  TenantStore,
} from './repository';

function clone<T>(v: T): T {
  return structuredClone(v);
}

class MemoryTenantRepository implements TenantRepository {
  constructor(private readonly tenants: Map<string, Tenant>) {}

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()].map(clone);
  }

  async getTenant(id: TenantId): Promise<Tenant | undefined> {
    const t = this.tenants.get(id);
    return t ? clone(t) : undefined;
  }

  async createTenant(tenant: Tenant): Promise<RepoResult<Tenant>> {
    if (this.tenants.has(tenant.id))
      return { ok: false, error: { code: 'conflict', message: 'tenant id exists' } };
    for (const t of this.tenants.values()) {
      if (t.slug === tenant.slug)
        return { ok: false, error: { code: 'conflict', message: 'tenant slug exists' } };
    }
    this.tenants.set(tenant.id, clone(tenant));
    return { ok: true, value: clone(tenant) };
  }

  async putTenant(tenant: Tenant): Promise<void> {
    this.tenants.set(tenant.id, clone(tenant));
  }
}

class MemorySiteRepository implements SiteRepository {
  constructor(private readonly sites: Map<string, Site>) {}

  async listSites(tenantId: TenantId): Promise<Site[]> {
    return [...this.sites.values()].filter((s) => s.tenantId === tenantId).map(clone);
  }

  async getSite(tenantId: TenantId, id: SiteId): Promise<Site | undefined> {
    const s = this.sites.get(id);
    return s && s.tenantId === tenantId ? clone(s) : undefined;
  }

  async createSite(site: Site): Promise<RepoResult<Site>> {
    if (this.sites.has(site.id))
      return { ok: false, error: { code: 'conflict', message: 'site id exists' } };
    this.sites.set(site.id, clone(site));
    return { ok: true, value: clone(site) };
  }

  async putSite(site: Site): Promise<void> {
    this.sites.set(site.id, clone(site));
  }
}

class MemoryDeviceRepository implements DeviceRepository {
  constructor(private readonly devices: Map<string, Device>) {}

  async listDevices(tenantId: TenantId, siteId: SiteId): Promise<Device[]> {
    return [...this.devices.values()]
      .filter((d) => d.tenantId === tenantId && d.siteId === siteId)
      .map(clone);
  }

  async getDevice(tenantId: TenantId, id: DeviceId): Promise<Device | undefined> {
    const d = this.devices.get(id);
    return d && d.tenantId === tenantId ? clone(d) : undefined;
  }

  async findDeviceById(id: DeviceId): Promise<Device | undefined> {
    const d = this.devices.get(id);
    return d ? clone(d) : undefined;
  }

  async createDevice(device: Device): Promise<RepoResult<Device>> {
    if (this.devices.has(device.id))
      return { ok: false, error: { code: 'conflict', message: 'device id exists' } };
    this.devices.set(device.id, clone(device));
    return { ok: true, value: clone(device) };
  }

  async putDevice(device: Device): Promise<void> {
    this.devices.set(device.id, clone(device));
  }

  // get→check→部分更新→set を await なしで行うため原子的（CAS, issue #239）。
  // 現在値から該当フィールドのみ変更し、他フィールドの並行更新を失わない。
  async consumeEnrollment(
    deviceId: DeviceId,
    expectedJti: string,
    lastSeenAt: string,
  ): Promise<boolean> {
    const cur = this.devices.get(deviceId);
    if (!cur || cur.enrollmentTokenId !== expectedJti) return false;
    this.devices.set(deviceId, clone({ ...cur, enrollmentTokenId: undefined, lastSeenAt }));
    return true;
  }
}

class MemoryAdminUserRepository implements AdminUserRepository {
  constructor(private readonly users: Map<string, AdminUser>) {}

  async getAdminUser(id: AdminUserId): Promise<AdminUser | undefined> {
    const u = this.users.get(id);
    return u ? clone(u) : undefined;
  }

  async findBySubject(subject: string): Promise<AdminUser | undefined> {
    if (!subject) return undefined;
    for (const u of this.users.values()) {
      if (u.entraSubject && u.entraSubject === subject) return clone(u);
    }
    return undefined;
  }

  async findByEmail(email: string): Promise<AdminUser | undefined> {
    const needle = email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === needle) return clone(u);
    }
    return undefined;
  }

  async putAdminUser(user: AdminUser): Promise<void> {
    this.users.set(user.id, clone(user));
  }
}

/** in-memory のテナントストア。テストでは seed を渡して状態を構築する。 */
export class MemoryTenantStore implements TenantStore {
  readonly tenants: TenantRepository;
  readonly sites: SiteRepository;
  readonly devices: DeviceRepository;
  readonly adminUsers: AdminUserRepository;

  constructor(seed?: {
    tenants?: Tenant[];
    sites?: Site[];
    devices?: Device[];
    adminUsers?: AdminUser[];
  }) {
    const tenants = new Map<string, Tenant>((seed?.tenants ?? []).map((t) => [t.id, clone(t)]));
    const sites = new Map<string, Site>((seed?.sites ?? []).map((s) => [s.id, clone(s)]));
    const devices = new Map<string, Device>((seed?.devices ?? []).map((d) => [d.id, clone(d)]));
    const users = new Map<string, AdminUser>((seed?.adminUsers ?? []).map((u) => [u.id, clone(u)]));
    this.tenants = new MemoryTenantRepository(tenants);
    this.sites = new MemorySiteRepository(sites);
    this.devices = new MemoryDeviceRepository(devices);
    this.adminUsers = new MemoryAdminUserRepository(users);
  }
}
