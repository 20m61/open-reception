/**
 * プラットフォーム障害・インシデント (issue #83 §6 / #90 increment 3e)。
 *
 * 総合開発者が「いまどこで何が起きているか」を横断把握するための障害情報モデルと、
 * その read 用集計・射影の純関数。I/O は持たない（永続化は src/lib/platform/incident-store）。
 *
 * セキュリティ/PII 方針（#83）: 横断 read 行には来訪者/担当者 PII を含めない。`updatedBy`
 * （操作者識別子）は表示行に載せず、誰が更新したかは監査ログ側で追う。title/message は
 * 運用者が記述する障害説明であり、機密値・個人情報を書かない運用とする。
 */

import { byFlagRankTimeDesc } from './scoped-summary';

/** 障害の影響範囲。 */
export type IncidentScope = 'platform' | 'tenant' | 'site' | 'device';

/** 重大度（低→高）。 */
export type IncidentSeverity = 'info' | 'minor' | 'major' | 'critical';

/** 対応状況。`resolved` 以外を「進行中（active）」とみなす。 */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/** 障害・インシデント（#83 推奨データモデル）。 */
export type Incident = {
  id: string;
  scope: IncidentScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  message: string;
  /** 発生日時（ISO）。 */
  startedAt: string;
  /** 復旧日時（ISO）。未復旧なら undefined。 */
  resolvedAt?: string;
  /** 最終更新者（操作者識別子）。横断 read 行には載せない。 */
  updatedBy: string;
};

/** 横断 read 用の障害行。PII・操作者識別子を含めない。 */
export type IncidentRow = {
  id: string;
  scope: IncidentScope;
  tenantId?: string;
  siteId?: string;
  deviceId?: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  message: string;
  startedAt: string;
  resolvedAt?: string;
  active: boolean;
};

/** 障害の横断集計。 */
export type IncidentSummary = {
  /** 進行中（resolved 以外）の件数。 */
  activeCount: number;
  /** 全件数（resolved 含む）。 */
  totalCount: number;
  /** 重大度内訳（進行中のみ）。 */
  activeBySeverity: Record<IncidentSeverity, number>;
  /** 表示用に並べ替えた行（進行中優先 → 重大度降順 → 発生新しい順）。 */
  incidents: IncidentRow[];
};

const SCOPES: readonly IncidentScope[] = ['platform', 'tenant', 'site', 'device'];
const SEVERITIES: readonly IncidentSeverity[] = ['info', 'minor', 'major', 'critical'];
const STATUSES: readonly IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];

/** 障害登録の入力（信頼できない外部入力）。 */
export type IncidentInput = {
  scope?: unknown;
  tenantId?: unknown;
  siteId?: unknown;
  deviceId?: unknown;
  severity?: unknown;
  status?: unknown;
  title?: unknown;
  message?: unknown;
  startedAt?: unknown;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 外部入力を検証して Incident を組み立てる純関数（登録 write 用）。
 * enum 妥当性・必須（title/message）・スコープ整合（tenant→tenantId 必須 等）を確認する。
 * status 既定は 'investigating'、startedAt 既定は now。id/updatedBy は呼び出し側が与える。
 */
export function buildIncident(
  input: IncidentInput,
  opts: { id: string; now: Date; updatedBy: string },
): { ok: true; value: Incident } | { ok: false; error: string } {
  const scope = str(input.scope) as IncidentScope;
  if (!SCOPES.includes(scope)) return { ok: false, error: 'invalid scope' };
  const severity = str(input.severity) as IncidentSeverity;
  if (!SEVERITIES.includes(severity)) return { ok: false, error: 'invalid severity' };
  const statusRaw = input.status === undefined ? 'investigating' : str(input.status);
  const status = statusRaw as IncidentStatus;
  if (!STATUSES.includes(status)) return { ok: false, error: 'invalid status' };
  const title = str(input.title);
  const message = str(input.message);
  if (title === '' || message === '') return { ok: false, error: 'title and message are required' };
  // 長さ上限（巨大な貼り付け＝secret/PII 混入や監査肥大を抑制。運用者記述は短文想定）。
  if (title.length > 200) return { ok: false, error: 'title too long (max 200)' };
  if (message.length > 2000) return { ok: false, error: 'message too long (max 2000)' };

  const tenantId = str(input.tenantId) || undefined;
  const siteId = str(input.siteId) || undefined;
  const deviceId = str(input.deviceId) || undefined;
  // スコープ整合: 下位スコープほど上位 id が要る。
  if (scope !== 'platform' && !tenantId) return { ok: false, error: 'tenantId required for this scope' };
  if ((scope === 'site' || scope === 'device') && !siteId) return { ok: false, error: 'siteId required for this scope' };
  if (scope === 'device' && !deviceId) return { ok: false, error: 'deviceId required for this scope' };

  // startedAt は **ISO へ正規化**して保存する（非 ISO の parse 可能値を verbatim 保存すると、read の
  // 辞書順ソート（byFlagRankTimeDesc）が ISO 前提で崩れるため）。parse 不能/未指定は now。
  const startedRaw = str(input.startedAt);
  const startedMs = startedRaw !== '' ? Date.parse(startedRaw) : NaN;
  const startedAt = Number.isNaN(startedMs) ? opts.now.toISOString() : new Date(startedMs).toISOString();

  return {
    ok: true,
    value: {
      id: opts.id,
      scope,
      tenantId: scope === 'platform' ? undefined : tenantId,
      siteId: scope === 'site' || scope === 'device' ? siteId : undefined,
      deviceId: scope === 'device' ? deviceId : undefined,
      severity,
      status,
      title,
      message,
      startedAt,
      resolvedAt: status === 'resolved' ? opts.now.toISOString() : undefined,
      updatedBy: opts.updatedBy,
    },
  };
}

/** 重大度の順位（大きいほど重大）。並べ替えに使う。 */
const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** 進行中（resolved 以外）か。 */
export function isActiveIncident(incident: Pick<Incident, 'status'>): boolean {
  return incident.status !== 'resolved';
}

/** 障害を横断 read 行へ射影する純関数（whitelist。updatedBy は載せない）。 */
export function toIncidentRow(incident: Incident): IncidentRow {
  return {
    id: incident.id,
    scope: incident.scope,
    tenantId: incident.tenantId,
    siteId: incident.siteId,
    deviceId: incident.deviceId,
    severity: incident.severity,
    status: incident.status,
    title: incident.title,
    message: incident.message,
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt,
    active: isActiveIncident(incident),
  };
}

/**
 * 障害一覧を横断集計する純関数。
 * 並び順: 進行中を先頭 → 重大度降順 → 発生日時の新しい順。
 */
export function summarizeIncidents(incidents: readonly Incident[]): IncidentSummary {
  const rows = incidents.map(toIncidentRow).sort(
    byFlagRankTimeDesc({
      flagOf: (r) => r.active,
      rankOf: (r) => SEVERITY_RANK[r.severity],
      timeOf: (r) => r.startedAt,
    }),
  );

  const activeBySeverity: Record<IncidentSeverity, number> = {
    info: 0,
    minor: 0,
    major: 0,
    critical: 0,
  };
  for (const row of rows) {
    if (row.active) activeBySeverity[row.severity] += 1;
  }

  return {
    activeCount: rows.filter((r) => r.active).length,
    totalCount: rows.length,
    activeBySeverity,
    incidents: rows,
  };
}
