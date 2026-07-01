import { NextResponse } from 'next/server';
import { buildIncident, type Incident, type IncidentInput } from '@/domain/platform/incident';
import { createIncident } from '@/lib/platform/incident-store';
import { handlePlatformDangerCreate } from '@/lib/platform/danger-create';

/**
 * POST /api/platform/incidents — 障害・インシデントの登録 (issue #83 AC7 / inc4c)。
 *
 * developer の**破壊的操作**。共有ハンドラ handlePlatformDangerCreate が JIT 昇格（assertElevated）・
 * 理由つき監査（audit-first + 補償）・whitelist 射影の不変条件を担保する。障害登録は全テナント横断の
 * platform 操作のため platform 全体スコープの昇格を要求する。title/message は PII/機密を書かない運用。
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handlePlatformDangerCreate<IncidentInput, Incident>(request, {
    build: (input, ctx) => buildIncident(input, { id: ctx.id, now: ctx.now, updatedBy: ctx.operator }),
    create: createIncident,
    action: 'platform.incident.created',
    targetType: 'incident',
    metadataOf: (v) => ({ scope: v.scope, severity: v.severity, status: v.status }),
    project: (v) => ({
      id: v.id,
      scope: v.scope,
      severity: v.severity,
      status: v.status,
      title: v.title,
      startedAt: v.startedAt,
    }),
    responseKey: 'incident',
  });
}
