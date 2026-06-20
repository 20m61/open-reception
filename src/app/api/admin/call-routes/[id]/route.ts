import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getCallRouteService } from '@/lib/notification/store';
import { callRouteResponse, readRouteScope, resolveAdminActor } from '@/lib/notification/request';
import { asCallRouteId, type CallTargetGroup, type UpdateCallRoutePatch } from '@/lib/notification/types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/call-routes/:id?tenantId= — 単一ルート取得 (issue #88)。
 * PATCH  /api/admin/call-routes/:id           — ルート名・グループ・有効/無効を更新する。
 * DELETE /api/admin/call-routes/:id?tenantId= — ルートを削除する。
 *
 * 認証/認可/監査は service 層で #80 認可（canAccessSite）と PII なし監査を適用する。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRouteScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getCallRouteService().get(actor, scope.tenantId, asCallRouteId(id));
  return callRouteResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRouteScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getCallRouteService().update(
    actor,
    scope.tenantId,
    asCallRouteId(id),
    parseUpdateBody(body),
  );
  return callRouteResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRouteScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getCallRouteService().remove(actor, scope.tenantId, asCallRouteId(id));
  if (result.ok) return new NextResponse(null, { status: 204 });
  return callRouteResponse(result);
}

/** 更新ボディを UpdateCallRoutePatch へ（指定されたフィールドのみ）。 */
function parseUpdateBody(body: unknown): UpdateCallRoutePatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: UpdateCallRoutePatch = {};
  if (typeof o.name === 'string') patch.name = o.name;
  if (Array.isArray(o.groups)) patch.groups = o.groups as CallTargetGroup[];
  if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
  return patch;
}
