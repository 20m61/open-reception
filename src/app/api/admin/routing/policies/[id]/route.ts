import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getRoutingService } from '@/lib/routing/store';
import { readRoutingScope, resolveAdminActor, routingResponse } from '@/lib/routing/request';
import { parseRoutingPolicyPatch } from '@/lib/routing/input';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/routing/policies/:id?tenantId= — 単一ポリシー取得（文章形式説明つき） (issue #374)。
 * PATCH  /api/admin/routing/policies/:id           — 名称・手順・fallback・有効/無効を更新する。
 * DELETE /api/admin/routing/policies/:id?tenantId= — ポリシーを削除する。
 *
 * 認可/監査は service 層で適用。保存前検証（循環・整合）で不正は 400（issues 同梱）。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().getPolicy(actor, scope.tenantId, id);
  return routingResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRoutingScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const parsed = parseRoutingPolicyPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error.code, message: parsed.error.message }, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().updatePolicy(actor, scope.tenantId, id, parsed.value);
  return routingResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getRoutingService().removePolicy(actor, scope.tenantId, id);
  if (result.ok) return new NextResponse(null, { status: 204 });
  return routingResponse(result);
}
