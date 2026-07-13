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

import { PLATFORM_SCOPES, toIso, trimStr, validateScopeIds } from './danger-input';

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

const MW_IMPACTS: readonly MaintenanceImpact[] = ['notice_only', 'limited', 'read_only', 'unavailable'];

/** メンテナンス登録の入力（信頼できない外部入力）。 */
export type MaintenanceWindowInput = {
  scope?: unknown;
  tenantId?: unknown;
  siteId?: unknown;
  deviceId?: unknown;
  impact?: unknown;
  message?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
};

/**
 * 外部入力を検証して MaintenanceWindow を組み立てる純関数（登録 write 用・#83 メンテナンス）。
 * enum 妥当性・スコープ整合（共有 danger-input）・message 必須+長さ上限・startsAt/endsAt の ISO 正規化と
 * 前後関係を確認する。**登録時 status は 'scheduled' 固定**（active/completed 等への遷移は別の更新操作）。
 */
export function buildMaintenanceWindow(
  input: MaintenanceWindowInput,
  opts: { id: string; now: Date; createdBy: string },
): { ok: true; value: MaintenanceWindow } | { ok: false; error: string } {
  const scope = trimStr(input.scope) as MaintenanceScope;
  if (!PLATFORM_SCOPES.includes(scope)) return { ok: false, error: 'invalid scope' };
  const impact = trimStr(input.impact) as MaintenanceImpact;
  if (!MW_IMPACTS.includes(impact)) return { ok: false, error: 'invalid impact' };
  const message = trimStr(input.message);
  if (message === '') return { ok: false, error: 'message is required' };
  if (message.length > 2000) return { ok: false, error: 'message too long (max 2000)' };

  const scoped = validateScopeIds(scope, input);
  if (!scoped.ok) return scoped;

  const startsAt = toIso(trimStr(input.startsAt));
  const endsAt = toIso(trimStr(input.endsAt));
  if (!startsAt || !endsAt) return { ok: false, error: 'startsAt and endsAt must be valid dates' };
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return { ok: false, error: 'endsAt must be after startsAt' };

  return {
    ok: true,
    value: {
      id: opts.id,
      scope,
      ...scoped.ids,
      status: 'scheduled', // 登録は必ず予定。監査アクション platform.maintenance.scheduled と一致させる。
      startsAt,
      endsAt,
      message,
      impact,
      createdBy: opts.createdBy,
      updatedAt: opts.now.toISOString(),
    },
  };
}

/** 受付端末（kiosk）のスコープ識別子。config enforcement の scope 一致判定に使う。 */
export type KioskMaintenanceScope = { tenantId?: string; siteId?: string; deviceId?: string };

/** enforcement 側へ渡す、現在有効なメンテナンスの最小情報（PII・createdBy は含めない）。 */
export type ActiveMaintenance = { impact: MaintenanceImpact; message: string; endsAt: string };

/** メンテナンスが対象 kiosk のスコープに影響するか（platform は全端末・下位は id 一致）。 */
function windowAffectsScope(window: MaintenanceWindow, scope: KioskMaintenanceScope): boolean {
  switch (window.scope) {
    case 'platform':
      return true;
    case 'tenant':
      return scope.tenantId !== undefined && window.tenantId === scope.tenantId;
    case 'site':
      return scope.siteId !== undefined && window.siteId === scope.siteId;
    case 'device':
      return scope.deviceId !== undefined && window.deviceId === scope.deviceId;
    default:
      return false;
  }
}

/**
 * kiosk のスコープに現在（now）影響しているメンテナンスのうち、最も影響度の重いものを返す純関数
 * （無ければ null）。I/O は持たない (issue #290 item3 の kiosk enforcement 解決)。
 *
 * 「現在影響している」= open（scheduled|active）かつ now ∈ [startsAt, endsAt]。時刻到来で自動的に
 * 効き、endsAt 経過で自動的に切れる（status の手動遷移漏れに依存しない）。completed / cancelled は
 * 時間内でも対象外。scope 一致は platform=全端末、tenant/site/device=各 id 一致。
 * 影響度は notice_only < limited < read_only < unavailable の順で最重を採る。
 */
export function resolveActiveMaintenance(
  windows: readonly MaintenanceWindow[],
  scope: KioskMaintenanceScope,
  now: Date,
): ActiveMaintenance | null {
  const nowMs = now.getTime();
  const affecting = windows.filter(
    (w) =>
      isOpenWindow(w) &&
      nowMs >= Date.parse(w.startsAt) &&
      nowMs <= Date.parse(w.endsAt) &&
      windowAffectsScope(w, scope),
  );
  if (affecting.length === 0) return null;
  const most = affecting.reduce((a, b) =>
    MW_IMPACTS.indexOf(b.impact) > MW_IMPACTS.indexOf(a.impact) ? b : a,
  );
  return { impact: most.impact, message: most.message, endsAt: most.endsAt };
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
