import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { asReceptionFlowId } from '@/domain/reception/custom-flow';
import { getReceptionFlowService } from '@/lib/reception/flow-config/store';
import { flowResponse, readFlowScope, resolveAdminActor } from '@/lib/reception/flow-config/request';
import type { UpdateReceptionFlowPatch } from '@/lib/reception/flow-config/types';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/reception-flows/:id?tenantId= — 単一フロー取得 (issue #100)。
 * PATCH  /api/admin/reception-flows/:id           — 表示名/説明/順序/ステップ/フィールド/有効無効を更新。
 * DELETE /api/admin/reception-flows/:id?tenantId= — フローを削除する。
 *
 * 認証/認可/監査は service 層で #80 認可（canAccessSite）と PII なし監査を適用する。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readFlowScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReceptionFlowService().get(actor, scope.tenantId, asReceptionFlowId(id));
  return flowResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readFlowScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReceptionFlowService().update(
    actor,
    scope.tenantId,
    asReceptionFlowId(id),
    parseUpdateBody(body),
  );
  return flowResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readFlowScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReceptionFlowService().remove(actor, scope.tenantId, asReceptionFlowId(id));
  if (result.ok) return new NextResponse(null, { status: 204 });
  return flowResponse(result);
}

/** 更新ボディを UpdateReceptionFlowPatch へ（指定されたフィールドのみ）。検証は service が行う。 */
function parseUpdateBody(body: unknown): UpdateReceptionFlowPatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: UpdateReceptionFlowPatch = {};
  if ('displayName' in o) patch.displayName = o.displayName;
  if ('description' in o) patch.description = o.description;
  if ('order' in o) patch.order = o.order;
  if ('steps' in o) patch.steps = o.steps;
  if ('fields' in o) patch.fields = o.fields;
  if ('completionMessage' in o) patch.completionMessage = o.completionMessage;
  if ('callRouteId' in o) patch.callRouteId = o.callRouteId;
  if (typeof o.enabled === 'boolean') patch.enabled = o.enabled;
  return patch;
}
