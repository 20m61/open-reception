import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { asSiteId } from '@/domain/tenant/types';
import { getReceptionFlowService } from '@/lib/reception/flow-config/store';
import { flowResponse, readFlowScope, resolveAdminActor } from '@/lib/reception/flow-config/request';

/**
 * GET  /api/admin/reception-flows?tenantId=&siteId= — 受付フロー一覧 (issue #100)。
 * POST /api/admin/reception-flows                    — 受付フローを作成する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界・write 権限を判定する
 *       （viewer 書込不可・他テナント越境拒否）。service 層で適用。
 * 監査: 作成を PII（来訪者入力値）なしで記録する（reception_flow.created）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readFlowScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getReceptionFlowService().list(actor, scope.tenantId, scope.siteId);
  return flowResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readFlowScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  if (!scope.siteId)
    return NextResponse.json({ code: 'invalid_input', message: 'siteId is required' }, { status: 400 });

  const o = (body ?? {}) as Record<string, unknown>;
  const result = await getReceptionFlowService().create(actor, {
    tenantId: scope.tenantId,
    siteId: asSiteId(scope.siteId),
    purposeKey: o.purposeKey,
    displayName: o.displayName,
    description: o.description,
    order: o.order,
    steps: o.steps,
    fields: o.fields,
    completionMessage: o.completionMessage,
    callRouteId: o.callRouteId,
  });
  return flowResponse(result, 201);
}
