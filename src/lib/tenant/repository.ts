/**
 * テナント基盤のリポジトリ interface (issue #80, increment 1)。
 *
 * 保存先非依存の抽象のみを定義する。DynamoDB シングルテーブル実装・S3 prefix 実配線は
 * 次増分（docs/multitenant-design.md §increment 計画）。本増分では interface と、
 * 単体テスト/開発用の in-memory 実装（./memory-repository.ts）を提供する。
 *
 * 既存 src/lib/data/backend.ts（Collection/Singleton/LogStore）の Result/エラー様式に
 * 合わせる。テナント境界の強制は本層では行わず、呼び出し側が
 * src/domain/tenant/authorization.ts の純関数で判定する責務分離とする。
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

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export interface TenantRepository {
  listTenants(): Promise<Tenant[]>;
  getTenant(id: TenantId): Promise<Tenant | undefined>;
  /** slug の重複は conflict。 */
  createTenant(tenant: Tenant): Promise<RepoResult<Tenant>>;
  putTenant(tenant: Tenant): Promise<void>;
}

export interface SiteRepository {
  /** 指定テナント配下のサイトのみ返す（テナント境界）。 */
  listSites(tenantId: TenantId): Promise<Site[]>;
  getSite(tenantId: TenantId, id: SiteId): Promise<Site | undefined>;
  createSite(site: Site): Promise<RepoResult<Site>>;
  putSite(site: Site): Promise<void>;
}

export interface DeviceRepository {
  /** 指定サイト配下の端末のみ返す。 */
  listDevices(tenantId: TenantId, siteId: SiteId): Promise<Device[]>;
  getDevice(tenantId: TenantId, id: DeviceId): Promise<Device | undefined>;
  createDevice(device: Device): Promise<RepoResult<Device>>;
  putDevice(device: Device): Promise<void>;
}

export interface AdminUserRepository {
  getAdminUser(id: AdminUserId): Promise<AdminUser | undefined>;
  /** Entra 安定主体（oid/sub）からの解決。認証連携の正キー。 */
  findBySubject(subject: string): Promise<AdminUser | undefined>;
  /** ログイン識別子（email）からの解決。subject で引けない場合の補助。 */
  findByEmail(email: string): Promise<AdminUser | undefined>;
  putAdminUser(user: AdminUser): Promise<void>;
}

/** テナント基盤の全リポジトリを束ねたファサード。 */
export interface TenantStore {
  readonly tenants: TenantRepository;
  readonly sites: SiteRepository;
  readonly devices: DeviceRepository;
  readonly adminUsers: AdminUserRepository;
}
