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
  const rows = incidents.map(toIncidentRow).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.severity !== b.severity) return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return b.startedAt.localeCompare(a.startedAt);
  });

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
