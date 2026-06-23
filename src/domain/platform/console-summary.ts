/**
 * プラットフォーム運用コンソールの概況集計 (issue #90, increment 1)。
 *
 * 総合開発者・プラットフォーム運用者が最初に知りたいのは個々の設定値ではなく
 * 「全テナントがいま安全に動いているか」である。本モジュールは全テナントの一覧
 * （Tenant）から、その横断概況を導く純関数群。
 *
 * I/O は持たない（テスト可能な純粋ロジックに閉じる）。データ取得と API 配線は
 * src/lib/platform / src/app/api/platform に置く。
 *
 * 実データが未接続の指標（直近エラー・外部連携エラー・認証エラー・総利用量・
 * コスト概算・メンテナンス状況）は本増分では集計せず、API 側で「未接続（pending）」
 * のプレースホルダとして明示する（docs/platform-console-design.md §increment 計画）。
 * ここで集計するのは Tenant ストアから確実に読める範囲（テナント数・稼働/停止）に限る。
 */
import type { Device, Site, Tenant } from '@/domain/tenant/types';
import type { AuditLog } from '@/domain/reception/log';
import type {
  AuthMethodStatus,
  ConnectionResult,
  IntegrationStatus,
} from '@/domain/security/integration-status';

/** 全テナントの稼働状況の横断集計。 */
export type TenantFleetSummary = {
  /** 全テナント数。 */
  total: number;
  /** 稼働中（status==='active'）テナント数。 */
  active: number;
  /** 停止中（status==='suspended'）テナント数。停止は「異常」ではなく運用上の意図的状態。 */
  suspended: number;
};

/**
 * 全テナント一覧からフリート概況を集計する。
 * 来訪者・担当者などの PII は一切含めない（テナントのメタ情報のみ）。
 */
export function summarizeTenantFleet(tenants: readonly Tenant[]): TenantFleetSummary {
  let active = 0;
  let suspended = 0;
  for (const t of tenants) {
    if (t.status === 'active') active += 1;
    else if (t.status === 'suspended') suspended += 1;
  }
  return { total: tenants.length, active, suspended };
}

/** テナント一覧行（テナント横断 read 用の最小表示形。機密値・PII は含めない）。 */
export type TenantRow = {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
  updatedAt: string;
};

/**
 * Tenant を一覧行に射影する。
 * 表示に不要な内部情報は落とし、名前順（次いで id 順）で安定ソートする。
 */
export function toTenantRows(tenants: readonly Tenant[]): TenantRow[] {
  return tenants
    .map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status, updatedAt: t.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/* ===================== increment 2: テナント詳細 read ===================== */

/** テナント詳細のサイト集計行（メタ情報のみ。PII・機密値は含めない）。 */
export type TenantSiteRow = {
  id: string;
  name: string;
  status: Site['status'];
  /** サイト配下の端末数。 */
  deviceCount: number;
  /** 稼働中（status==='active'）の端末数。 */
  activeDeviceCount: number;
};

/** サイト/デバイス集計を含むテナント詳細（テナント横断 read 用）。 */
export type TenantDetail = {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
  createdAt: string;
  updatedAt: string;
  /** サイト数。 */
  siteCount: number;
  /** 全サイト合計の端末数。 */
  deviceCount: number;
  /** 全サイト合計の稼働中端末数。 */
  activeDeviceCount: number;
  /** メンテナンス表示中の端末数（運用状態の把握用）。 */
  maintenanceDeviceCount: number;
  sites: TenantSiteRow[];
};

/**
 * テナント本体と、その配下のサイト・デバイス（サイトごとにまとまった配列）から
 * テナント詳細ビューを集計する純関数。
 * 端末トークン等の機密や来訪者/担当者 PII は一切含めない（数・状態のメタ情報のみ）。
 *
 * @param sitesWithDevices サイトと、そのサイトに属する Device 配列の組。呼び出し側が
 *   テナント境界（tenantId 一致）を保証して渡す前提。
 */
export function summarizeTenantDetail(
  tenant: Tenant,
  sitesWithDevices: readonly { site: Site; devices: readonly Device[] }[],
): TenantDetail {
  const sites: TenantSiteRow[] = sitesWithDevices
    .map(({ site, devices }) => ({
      id: site.id,
      name: site.name,
      status: site.status,
      deviceCount: devices.length,
      activeDeviceCount: devices.filter((d) => d.status === 'active').length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  let deviceCount = 0;
  let activeDeviceCount = 0;
  let maintenanceDeviceCount = 0;
  for (const { devices } of sitesWithDevices) {
    for (const d of devices) {
      deviceCount += 1;
      if (d.status === 'active') activeDeviceCount += 1;
      if (d.maintenance) maintenanceDeviceCount += 1;
    }
  }

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    siteCount: sitesWithDevices.length,
    deviceCount,
    activeDeviceCount,
    maintenanceDeviceCount,
    sites,
  };
}

/* ===================== increment 2: メンテナンス状況 read ===================== */

/** メンテナンス表示中の端末（テナント横断の運用把握用。機密・PII は含めない）。 */
export type MaintenanceDeviceRow = {
  tenantId: string;
  tenantName: string;
  siteId: string;
  deviceId: string;
  deviceName: string;
};

/** メンテナンス状況の横断集計。 */
export type MaintenanceSummary = {
  /** メンテナンス表示中の端末数。 */
  devicesInMaintenance: number;
  /** メンテナンス表示中の端末一覧（端末名は運用メモであり PII ではない）。 */
  devices: MaintenanceDeviceRow[];
};

/**
 * 全テナントの端末から「メンテナンス表示中」の端末を抽出して横断集計する純関数。
 * 機密値・PII は含めず、運用上の把握に必要な id・名前のみを返す。
 */
export function summarizeMaintenance(
  entries: readonly { tenant: Tenant; devices: readonly Device[] }[],
): MaintenanceSummary {
  const devices: MaintenanceDeviceRow[] = [];
  for (const { tenant, devices: ds } of entries) {
    for (const d of ds) {
      if (!d.maintenance) continue;
      devices.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        siteId: d.siteId,
        deviceId: d.id,
        deviceName: d.name,
      });
    }
  }
  devices.sort(
    (a, b) => a.tenantName.localeCompare(b.tenantName) || a.deviceName.localeCompare(b.deviceName),
  );
  return { devicesInMaintenance: devices.length, devices };
}

/* ===================== increment 2: 監査ログ（マスク済み read） ===================== */

/** マスク済み監査ログ行（テナント横断 read 用）。機密・PII を含めない。 */
export type MaskedAuditRow = {
  id: string;
  at: string;
  action: string;
  /** マスク済みの操作主体ラベル（メール等の PII を伏せる）。 */
  actor: string;
  targetType?: string;
  targetId?: string;
};

/**
 * 監査ログの actor をマスクする純関数。
 *
 * 既存の actor 表記（`kiosk:<id>` / `admin` / `admin:<userId>` 等）のうち、識別子が
 * メールアドレスや個人を特定しうる文字列である可能性を考慮し、`<種別>:<識別子>` の
 * 識別子部分を伏せる。種別ラベル（kiosk / admin など）は残し、誰が何系統の操作をしたか
 * の粒度だけを見せる（#83 PII 非露出方針）。
 */
export function maskAuditActor(actor: string): string {
  const idx = actor.indexOf(':');
  if (idx === -1) return actor;
  const kind = actor.slice(0, idx);
  return `${kind}:***`;
}

/**
 * 監査ログをマスク済み行へ射影する純関数（新しい順を維持）。
 * 来訪者/担当者の PII を含めないことは AuditLog 設計（PII を残さない）で担保されているが、
 * actor の識別子部分は念のためマスクする。metadata は表示に載せない。
 */
export function toMaskedAuditRows(logs: readonly AuditLog[]): MaskedAuditRow[] {
  return logs.map((log) => ({
    id: log.id,
    at: log.at,
    action: log.action,
    actor: maskAuditActor(log.actor),
    targetType: log.targetType,
    targetId: log.targetId,
  }));
}

/* ===================== increment 3: 外部連携状態（read 射影） ===================== */

/** 外部連携の横断 read 行。登録状態・接続結果・最終日時のみ。機密値は含めない。 */
export type IntegrationStatusRow = {
  id: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  lastResult: ConnectionResult;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorSummary?: string;
};

/** 管理ログイン方式の横断 read 行。Client Secret 等は含めない。 */
export type AuthMethodStatusRow = {
  id: string;
  label: string;
  enabled: boolean;
  issues: string[];
};

/**
 * 外部連携状態を read 行へ射影する純関数（label 昇順）。
 *
 * `IntegrationStatus` 自体が機密値を持たない設計だが、ここで**表示に必要なフィールドのみ
 * を明示的に whitelist** し、将来 `IntegrationStatus` にフィールドが増えても platform の
 * 横断 read へ機密が漏れないようにする（#83 機密非露出方針）。
 */
export function toIntegrationStatusRows(
  statuses: readonly IntegrationStatus[],
): IntegrationStatusRow[] {
  return statuses
    .map((s) => ({
      id: s.id,
      label: s.label,
      configured: s.configured,
      enabled: s.enabled,
      lastResult: s.lastResult,
      lastSuccessAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      lastErrorSummary: s.lastErrorSummary,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * 管理ログイン方式を read 行へ射影する純関数（label 昇順）。
 * 表示に必要なフィールドのみを whitelist し、機密値の漏えいを防ぐ。
 */
export function toAuthMethodStatusRows(
  methods: readonly AuthMethodStatus[],
): AuthMethodStatusRow[] {
  return methods
    .map((m) => ({ id: m.id, label: m.label, enabled: m.enabled, issues: [...m.issues] }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
