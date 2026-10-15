/**
 * テナント基盤のリポジトリ interface (issue #80, increment 1)。
 *
 * 保存先非依存の抽象のみを定義する。実装は §9 標準（docs/persistence-design.md #274）どおり
 * getBackend() 委譲の 1 つだけ（./data-repository.ts）。エンティティごとの in-memory 実装は
 * 持たない（テストは memory backend + seed で行う。旧 ./memory-repository.ts は #274 ② で廃止）。
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

/** {@link DeviceRepository.updateDeviceFields} が書いてよい欄。status と世代は含めない。 */
export type DeviceFieldChanges = Partial<
  Pick<
    Device,
    'name' | 'location' | 'kind' | 'maintenance' | 'tokenRegistered' | 'enrollmentTokenId' | 'updatedAt'
  >
>;

export interface DeviceRepository {
  /** 指定サイト配下の端末のみ返す。 */
  listDevices(tenantId: TenantId, siteId: SiteId): Promise<Device[]>;
  /**
   * 指定テナント配下の全端末を返す（テナント境界つきの境界クエリ, #274/#284）。
   * 実装は storage 側の境界クエリ（dynamo: tenantId の GSI1、memory: 等価フィルタ）で行い、
   * 読み取り量はテナント内の台数に比例する。
   *
   * 横断集計（#261 死活集計）の呼び出し規約:
   *   - 旧 listAllDevices（テナント横断の全件読み）は本メソッドへ置換した。横断集計は
   *     「テナント一覧起点 + テナント毎の本クエリ」で行う（テナント数は契約規模で小さい）。
   *   - 毎リクエストで直接呼ばない。集計は src/lib/tenant/device-fleet.ts の TTL キャッシュ
   *     越しに行い、無境界フルスキャンの再来（#254 / #260 撤回理由 3）を防ぐ。
   *   - 露出は件数集計のみ・PII/token なし。developer 限定 surface（observability）と、
   *     単一テナント互換運用の admin ダッシュボードから使う。通常の管理 API はサイト境界つきの
   *     listDevices を使うこと。
   */
  listDevicesByTenant(tenantId: TenantId): Promise<Device[]>;
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
  /**
   * レコード全体を置き換える。🔴 **seed・テスト専用。DeviceService の書き込み経路では使わない**。
   * 読んだ時点の値で丸ごと上書きするため、read→write の間に consumeEnrollment が上げた
   * `credentialGeneration` や、別の管理操作が変えた `status` を巻き戻す（#1237 の follow-up）。
   * サービスは {@link updateDeviceFields} / {@link changeDeviceStatus} を使う。
   */
  putDevice(device: Device): Promise<void>;
  /**
   * 表示メタ・エンロール URL の欄だけを**部分更新**する（条件なし。端末が無ければ false）。
   * 型の上で `status` と `credentialGeneration` を書けないので、並行する登録状態の切替や
   * エンロールの消費を巻き戻さない（#1237 の follow-up）。値が `undefined` の欄は消える。
   */
  updateDeviceFields(deviceId: DeviceId, changes: DeviceFieldChanges): Promise<boolean>;
  /**
   * 登録状態を**条件付き部分更新**で切り替える（#1237 の follow-up）。現在の
   * `credentialGeneration` が `expectedGeneration` と一致するときだけ `status` と世代を書き、
   * 保留中のエンロール URL（`enrollmentTokenId`）を消して true。一致しない・端末が無いなら
   * 何も書かず false。`expectedGeneration` の `undefined` は「欄が無い」を要求する（旧レコード）。
   * 条件は世代だけで足りる —— status の切替とエンロールの消費は必ず世代を上げるので、
   * 読んだあとに status が変わっていれば世代も変わっている。
   * `credentialGeneration` を省くと世代は書かない。
   */
  changeDeviceStatus(
    deviceId: DeviceId,
    change: {
      expectedGeneration: number | undefined;
      status: Device['status'];
      credentialGeneration?: number;
      updatedAt: string;
    },
  ): Promise<boolean>;
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
   *
   * 同じ書込で端末証明の世代を `generation.next` へ上げる (#1237)。世代も `generation.expected`
   * （読んだ時点の値。未設定は undefined）との一致を条件にするので、間に世代が変わっていれば false。
   */
  consumeEnrollment(
    deviceId: DeviceId,
    expectedJti: string,
    lastSeenAt: string,
    generation: { expected: number | undefined; next: number },
  ): Promise<boolean>;
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
