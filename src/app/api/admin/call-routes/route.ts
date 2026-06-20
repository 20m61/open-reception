import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { asSiteId } from '@/domain/tenant/types';
import { getCallRouteService } from '@/lib/notification/store';
import { callRouteResponse, readRouteScope, resolveAdminActor } from '@/lib/notification/request';
import type { CallTargetGroup } from '@/lib/notification/types';

/**
 * GET  /api/admin/call-routes?tenantId=&siteId= — 通知ルート一覧 (issue #88)。
 * POST /api/admin/call-routes                    — 通知ルートを作成する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界・write 権限を判定する
 *       （viewer 書込不可・他テナント越境拒否）。
 * 監査: 作成を PII（通知先 value）なしで記録する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRouteScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getCallRouteService().list(actor, scope.tenantId, scope.siteId);
  return callRouteResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRouteScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  if (!scope.siteId)
    return NextResponse.json({ code: 'invalid_input', message: 'siteId is required' }, { status: 400 });

  const o = (body ?? {}) as Record<string, unknown>;
  const result = await getCallRouteService().create(actor, {
    tenantId: scope.tenantId,
    siteId: asSiteId(scope.siteId),
    name: typeof o.name === 'string' ? o.name : '',
    groups: Array.isArray(o.groups) ? (o.groups as CallTargetGroup[]) : undefined,
  });
  return callRouteResponse(result, 201);
}
