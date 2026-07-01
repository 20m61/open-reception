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
  /**
   * テナント境界を跨いで全端末を返す (issue #83 オブザーバビリティ)。platform 横断の稼働状態集計に使う。
   * 呼び出し側は platform 認可（developer 限定）でゲートすること。通常の管理 API は listDevices を使う。
   */
  listAllDevices(): Promise<Device[]>;
  getDevice(tenantId: TenantId, id: DeviceId): Promise<Device | undefined>;
  /**
   * テナント境界を跨いで id だけで端末を引く (issue #87 inc3)。
   * Kiosk→Device 統合で、テナント文脈を持たない kiosk heartbeat から対応 Device を
   * 解決するために使う。Device の id は kiosk レジストリの id と一致させて寄せる方針
   * （docs/site-device-management-design.md §Device/Kiosk 統合）。通常の管理 API は
   * テナント境界つきの getDevice/listDevices を使うこと。
   */
  findDeviceById(id: DeviceId): Promise<Device | undefined>;
  createDevice(device: Device): Promise<RepoResult<Device>>;
  putDevice(device: Device): Promise<void>;
  /**
   * `lastSeenAt` **だけ**を部分更新する（heartbeat 用, issue #239）。全置換 put は read→write 間に
   * 別経路（consumeEnrollment の消去）で変わった `enrollmentTokenId` を stale 値で書き戻し、消費済
   * トークンを復活させ得る。lastSeenAt のみ触ることでこの lost-update を避ける。端末なしは no-op。
   */
  touchLastSeen(deviceId: DeviceId, lastSeenAt: string): Promise<void>;
  /**
   * エンロールトークンを**原子的に**消費する (issue #239)。現在の `enrollmentTokenId` が
   * `expectedJti` に一致するときのみ、enrollmentTokenId を消去し lastSeenAt を更新して true。
   * 一致しない（消費済 / 競合で他が先に消費 / 端末なし）なら false。アイテム全体を置換せず
   * 当該フィールドのみ条件付き部分更新するため、他フィールドの並行更新を失わない（lost-update 回避）。
   */
  consumeEnrollment(deviceId: DeviceId, expectedJti: string, lastSeenAt: string): Promise<boolean>;
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
