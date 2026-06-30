/**
 * マルチテナント基盤のドメイン型 (issue #80, increment 1)。
 *
 * 用語（Issue #80 の定義に準拠）:
 *   - Tenant: 導入先企業・組織。最上位の境界。
 *   - Site:   Tenant 配下の受付設置拠点。
 *   - Device: Site 配下の受付端末（既存 Kiosk をテナント境界に乗せる位置づけ）。
 *   - AdminUser: 管理画面にログインするユーザー。Tenant/Site に対し権限を持つ。
 *
 * 関連: Tenant 1—* Site 1—* Device。
 *
 * このモジュールは純粋なドメイン型のみを定義し、外部 I/O は持たない。
 * 永続化・認証連携・S3 prefix 実配線は次増分（docs/multitenant-design.md 参照）。
 */

/** ブランド付き ID 型。混在（tenantId を siteId に渡す等）を型で防ぐ。 */
export type TenantId = string & { readonly __brand: 'TenantId' };
export type SiteId = string & { readonly __brand: 'SiteId' };
export type DeviceId = string & { readonly __brand: 'DeviceId' };
export type AdminUserId = string & { readonly __brand: 'AdminUserId' };

/** 文字列を各 ID 型へ畳み込むヘルパ（境界での明示的な型付けに使う）。 */
export const asTenantId = (v: string): TenantId => v as TenantId;
export const asSiteId = (v: string): SiteId => v as SiteId;
export const asDeviceId = (v: string): DeviceId => v as DeviceId;
export const asAdminUserId = (v: string): AdminUserId => v as AdminUserId;

/**
 * エンティティの状態。
 * - active:    通常運用中。
 * - suspended: 一時停止（課金停止・運用停止など）。データは残すが受付・操作は不可。
 */
export type TenantStatus = 'active' | 'suspended';
export type SiteStatus = 'active' | 'suspended';
/** Device は登録/失効の二値（既存 Kiosk.enabled と対応）。 */
export type DeviceStatus = 'active' | 'revoked';

/**
 * 受付端末の種別 (issue #87 inc2)。一覧の表示用。既定は kiosk（据置受付端末）。
 */
export type DeviceKind = 'kiosk' | 'tablet' | 'desktop';

/** 導入先企業・組織。テナント境界の最上位。 */
export type Tenant = {
  id: TenantId;
  /** 表示名（例: AVITA）。 */
  name: string;
  /** URL/識別子に使う短いスラッグ（一意・小文字英数字想定）。 */
  slug: string;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
};

/** Tenant 配下の受付設置拠点。 */
export type Site = {
  id: SiteId;
  tenantId: TenantId;
  /** 表示名（例: 本社受付）。 */
  name: string;
  status: SiteStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Site 配下の受付端末。テナント境界に乗せた Device 表現。
 *
 * #87 inc2 で受付端末管理 UI 用の表示メタを追加（すべて任意・後方互換）。
 * セキュリティ: token の平文は保持しない。登録済みかの真偽（`tokenRegistered`）のみ持つ。
 */
export type Device = {
  id: DeviceId;
  tenantId: TenantId;
  siteId: SiteId;
  /** 表示名（例: iPad受付端末）。 */
  name: string;
  status: DeviceStatus;
  /** 設置場所（例: 1F エントランス）。任意・PII ではない運用メモ。 */
  location?: string;
  /** 端末種別。未指定は kiosk 扱い。 */
  kind?: DeviceKind;
  /** 最終 heartbeat（オンライン判定の基準）。未取得なら未設定。 */
  lastSeenAt?: string;
  /** メンテナンス表示中か（受付を止め保守メッセージを出す）。 */
  maintenance?: boolean;
  /**
   * キオスク token が登録済みか（真偽のみ。平文・ハッシュは保持しない）。
   * 再発行・失効の運用状態を UI に出すために使う。
   */
  tokenRegistered?: boolean;
  /**
   * 現在有効なエンロールトークンの jti（使い捨て検証用。docs/reception-issuance-design.md §3）。
   * 平文トークンは保持しない（jti のみ）。発行で採番・consume / 再発行で無効化（消去・更新）。
   */
  enrollmentTokenId?: string;
  createdAt: string;
  updatedAt: string;
};

/** 管理画面ロール (Issue #80 想定ロール表)。 */
export const TENANT_ROLES = [
  'developer',
  'tenant_admin',
  'site_manager',
  'viewer',
  'kiosk_device',
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * ロールの割り当て（メンバーシップ）。1 ユーザーが複数テナント/サイトに所属しうる。
 * スコープ境界:
 *   - developer:    全テナント横断。tenantId/siteId は不問（null）。
 *   - tenant_admin: tenantId 必須・siteId は不問（テナント全体）。
 *   - site_manager: tenantId + siteId 必須（特定サイト）。
 *   - viewer:       tenantId 必須・siteId は任意（テナント or サイト単位の閲覧）。
 *   - kiosk_device: tenantId + siteId + deviceId 必須（端末専用）。
 */
export type RoleAssignment = {
  role: TenantRole;
  /** developer は null。それ以外は対象テナント。 */
  tenantId: TenantId | null;
  /** site_manager / kiosk_device は必須。tenant_admin/developer は null。viewer は任意。 */
  siteId: SiteId | null;
  /** kiosk_device のみ。それ以外は null。 */
  deviceId: DeviceId | null;
};

/** 管理画面ユーザー。Entra 認証ソースとの紐付けは `entraSubject` で行う（increment 2）。 */
export type AdminUser = {
  id: AdminUserId;
  /**
   * Entra ID の安定主体識別子（`oid` 優先、無ければ `sub`）。
   * 認証連携で AdminUser を一意に解決する正キー。メール変更に追従できるよう
   * email とは独立に保持する。password セッション由来のユーザーには無い（任意）。
   */
  entraSubject?: string;
  /** ログイン識別子（メール等）。PII 最小化のため表示・補助解決用途以外には保持しない。 */
  email: string;
  displayName: string;
  /** 所属とロール。複数テナント/サイトに跨りうる。 */
  assignments: RoleAssignment[];
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
};

/** 型ガード。 */
export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === 'string' && (TENANT_ROLES as readonly string[]).includes(value);
}
