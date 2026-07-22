import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getRoutingService } from '@/lib/routing/store';
import { readRoutingScope, resolveAdminActor, routingResponse } from '@/lib/routing/request';

/**
 * GET  /api/admin/routing/endpoints?tenantId=&siteId= — 接続先（ContactEndpoint）一覧 (issue #374)。
 * POST /api/admin/routing/endpoints                    — 接続先を登録する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 純関数（canAccessSite / canAccessTenant）で境界・write 権限を判定（service 層）。
 * 監査: 作成を PII（アドレス）なしで記録する（contact_endpoint.created）。
 * PII: レスポンスはアドレスをマスクした EndpointView のみ（e164/uri を返さない）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getRoutingService().listEndpoints(actor, scope.tenantId, scope.siteId);
  return routingResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRoutingScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const result = await getRoutingService().createEndpoint(actor, {
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    raw: body,
  });
  return routingResponse(result, 201);
}
