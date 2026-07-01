import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { buildIncident, type IncidentInput } from '@/domain/platform/incident';
import { createIncident } from '@/lib/platform/incident-store';
import { recordDangerAction } from '@/lib/admin/audit';
import { assertElevated } from '@/lib/platform/request';

/**
 * POST /api/platform/incidents — 障害・インシデントの登録 (issue #83 AC7 / inc4c)。
 *
 * developer の**破壊的操作**。JIT 昇格（assertElevated）必須 + 理由つき監査（recordDangerAction）。
 * 障害登録は全テナント横断の platform 操作のため、platform 全体スコープの昇格を要求する。
 * title/message は運用者記述で PII/機密を書かない運用（横断 read 行に updatedBy は載せない）。
 * 認可: 未認証 401 / 非 developer 403 / 未昇格 403 elevation_required。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const gate = await assertElevated();
  if (!gate.ok) return gate.response;

  const input = ((await request.json().catch(() => ({}))) ?? {}) as IncidentInput & { reason?: unknown };
  const built = buildIncident(input, { id: randomUUID(), now: new Date(), updatedBy: 'platform' });
  if (!built.ok) {
    return NextResponse.json({ error: 'invalid_input', message: built.error }, { status: 400 });
  }
  await createIncident(built.value);

  const reason = typeof input.reason === 'string' ? input.reason.trim() : undefined;
  await recordDangerAction({
    action: 'platform.incident.created',
    target: { type: 'incident', id: built.value.id },
    reason: reason || undefined,
    metadata: { scope: built.value.scope, severity: built.value.severity, status: built.value.status },
    request,
  });

  return NextResponse.json(
    {
      incident: {
        id: built.value.id,
        scope: built.value.scope,
        severity: built.value.severity,
        status: built.value.status,
        title: built.value.title,
        startedAt: built.value.startedAt,
      },
    },
    { status: 201 },
  );
}
