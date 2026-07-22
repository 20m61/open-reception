import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getRoutingService } from '@/lib/routing/store';
import { readRoutingScope, resolveAdminActor, routingResponse } from '@/lib/routing/request';
import type { UpdateEndpointPatch } from '@/lib/routing/service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/routing/endpoints/:id?tenantId= — 単一接続先取得 (issue #374)。
 * PATCH  /api/admin/routing/endpoints/:id           — ラベル・有効/無効・所有者・アドレスを更新。
 * DELETE /api/admin/routing/endpoints/:id?tenantId= — 接続先を削除する。
 *
 * 認可/監査/PII は service 層で適用（アドレスはレスポンスに出さない）。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().getEndpoint(actor, scope.tenantId, id);
  return routingResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRoutingScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().updateEndpoint(actor, scope.tenantId, id, parseUpdateBody(body));
  return routingResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().removeEndpoint(actor, scope.tenantId, id);
  if (result.ok) return new NextResponse(null, { status: 204 });
  return routingResponse(result);
}

/** 更新ボディを UpdateEndpointPatch へ（指定フィールドのみ）。 */
function parseUpdateBody(body: unknown): UpdateEndpointPatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: UpdateEndpointPatch = {};
  if (o.label === null) patch.label = null;
  else if (typeof o.label === 'string') patch.label = o.label;
  if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
  if (typeof o.ownerId === 'string') patch.ownerId = o.ownerId;
  if (typeof o.address === 'string') patch.address = o.address;
  return patch;
}
