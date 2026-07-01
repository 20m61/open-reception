/**
 * 予定メンテナンス（MaintenanceWindow） (issue #83 §8 / #90 increment 3e)。
 *
 * 総合開発者が「いつ・どこで・どの影響度でメンテナンスが予定/進行しているか」を横断把握する
 * ためのモデルと read 用集計・射影の純関数。I/O は持たない（永続化は
 * src/lib/platform/maintenance-window-store）。
 *
 * セキュリティ/PII 方針（#83）: 横断 read 行に PII を含めない。`createdBy`（操作者識別子）は
 * 表示行に載せない。message は運用者が記述する案内であり機密値・個人情報を書かない運用とする。
 */

/** 影響範囲。 */
export type MaintenanceScope = 'platform' | 'tenant' | 'site' | 'device';

/** 予定メンテナンスの状態。`scheduled`/`active` を「進行/予定（open）」とみなす。 */
export type MaintenanceWindowStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

/** 影響度（軽→重）。 */
export type MaintenanceImpact = 'notice_only' | 'limited' | 'read_only' | 'unavailable';

/** 予定メンテナンス（#83 推奨データモデル）。 */
export type MaintenanceWindow = {
  id: string;
  scope: MaintenanceScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  status: MaintenanceWindowStatus;
  /** 開始予定（ISO）。 */
  startsAt: string;
  /** 終了予定（ISO）。 */
  endsAt: string;
  message: string;
  impact: MaintenanceImpact;
  /** 作成者（操作者識別子）。横断 read 行には載せない。 */
  createdBy: string;
  /** 最終更新（ISO）。 */
  updatedAt: string;
};

/** 横断 read 用の行。PII・操作者識別子を含めない。 */
export type MaintenanceWindowRow = {
  id: string;
  scope: MaintenanceScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  status: MaintenanceWindowStatus;
  startsAt: string;
  endsAt: string;
  message: string;
  impact: MaintenanceImpact;
  /** scheduled / active を open とみなす。 */
  open: boolean;
};

/** 予定メンテナンスの横断集計。 */
export type MaintenanceWindowSummary = {
  /** 進行中（status='active'）の件数。 */
  activeCount: number;
  /** 予定（status='scheduled'）の件数。 */
  scheduledCount: number;
  /** 全件数。 */
  totalCount: number;
  /** 表示用に並べ替えた行（open 優先 → 開始予定の早い順）。 */
  windows: MaintenanceWindowRow[];
};

/** 進行/予定（scheduled or active）か。 */
export function isOpenWindow(window: Pick<MaintenanceWindow, 'status'>): boolean {
  return window.status === 'scheduled' || window.status === 'active';
}

const MW_SCOPES: readonly MaintenanceScope[] = ['platform', 'tenant', 'site', 'device'];
const MW_STATUSES: readonly MaintenanceWindowStatus[] = ['scheduled', 'active', 'completed', 'cancelled'];
const MW_IMPACTS: readonly MaintenanceImpact[] = ['notice_only', 'limited', 'read_only', 'unavailable'];

/** メンテナンス登録の入力（信頼できない外部入力）。 */
export type MaintenanceWindowInput = {
  scope?: unknown;
  tenantId?: unknown;
  siteId?: unknown;
  deviceId?: unknown;
  status?: unknown;
  impact?: unknown;
  message?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
};

function mwStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
/** ISO へ正規化（read の辞書順ソートが ISO 前提のため）。parse 不能は null。 */
function toIso(raw: string): string | null {
  if (raw === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 外部入力を検証して MaintenanceWindow を組み立てる純関数（登録 write 用・#83 AC メンテナンス）。
 * enum 妥当性・スコープ整合・message 必須+長さ上限・startsAt/endsAt の ISO 正規化と前後関係を確認する。
 * status 既定 'scheduled'。id/createdBy/now は呼び出し側が与える。
 */
export function buildMaintenanceWindow(
  input: MaintenanceWindowInput,
  opts: { id: string; now: Date; createdBy: string },
): { ok: true; value: MaintenanceWindow } | { ok: false; error: string } {
  const scope = mwStr(input.scope) as MaintenanceScope;
  if (!MW_SCOPES.includes(scope)) return { ok: false, error: 'invalid scope' };
  const impact = mwStr(input.impact) as MaintenanceImpact;
  if (!MW_IMPACTS.includes(impact)) return { ok: false, error: 'invalid impact' };
  const status = (input.status === undefined ? 'scheduled' : mwStr(input.status)) as MaintenanceWindowStatus;
  if (!MW_STATUSES.includes(status)) return { ok: false, error: 'invalid status' };
  const message = mwStr(input.message);
  if (message === '') return { ok: false, error: 'message is required' };
  if (message.length > 2000) return { ok: false, error: 'message too long (max 2000)' };

  const tenantId = mwStr(input.tenantId) || undefined;
  const siteId = mwStr(input.siteId) || undefined;
  const deviceId = mwStr(input.deviceId) || undefined;
  if (scope !== 'platform' && !tenantId) return { ok: false, error: 'tenantId required for this scope' };
  if ((scope === 'site' || scope === 'device') && !siteId) return { ok: false, error: 'siteId required for this scope' };
  if (scope === 'device' && !deviceId) return { ok: false, error: 'deviceId required for this scope' };

  const startsAt = toIso(mwStr(input.startsAt));
  const endsAt = toIso(mwStr(input.endsAt));
  if (!startsAt || !endsAt) return { ok: false, error: 'startsAt and endsAt must be valid dates' };
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return { ok: false, error: 'endsAt must be after startsAt' };

  return {
    ok: true,
    value: {
      id: opts.id,
      scope,
      tenantId: scope === 'platform' ? undefined : tenantId,
      siteId: scope === 'site' || scope === 'device' ? siteId : undefined,
      deviceId: scope === 'device' ? deviceId : undefined,
      status,
      startsAt,
      endsAt,
      message,
      impact,
      createdBy: opts.createdBy,
      updatedAt: opts.now.toISOString(),
    },
  };
}

/** 予定メンテナンスを横断 read 行へ射影する純関数（whitelist。createdBy は載せない）。 */
export function toMaintenanceWindowRow(window: MaintenanceWindow): MaintenanceWindowRow {
  return {
    id: window.id,
    scope: window.scope,
    tenantId: window.tenantId,
    siteId: window.siteId,
    deviceId: window.deviceId,
    status: window.status,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    message: window.message,
    impact: window.impact,
    open: isOpenWindow(window),
  };
}

/**
 * 予定メンテナンス一覧を横断集計する純関数。
 * 並び順: open（進行/予定）を先頭 → 開始予定の早い順。
 */
export function summarizeMaintenanceWindows(
  windows: readonly MaintenanceWindow[],
): MaintenanceWindowSummary {
  const rows = windows.map(toMaintenanceWindowRow).sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return a.startsAt.localeCompare(b.startsAt);
  });

  return {
    activeCount: rows.filter((r) => r.status === 'active').length,
    scheduledCount: rows.filter((r) => r.status === 'scheduled').length,
    totalCount: rows.length,
    windows: rows,
  };
}
