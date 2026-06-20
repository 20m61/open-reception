import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getStayService } from '@/lib/visit/store';
import { readScope, resolveAdminActor, serviceResponse } from '@/lib/visit/request';

/**
 * GET  /api/admin/stay?tenantId=&siteId= — テナント/サイトの滞在一覧 (issue #102)。
 * POST /api/admin/stay                    — 在館記録を起票する（present）。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界を判定する（StayService 内）。
 * 監査: 起票を PII なしで記録する。
 *
 * 一覧/起票とも PII を持たない（来訪者識別は参照のみ）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getStayService().list(actor, scope.tenantId, scope.siteId);
  return serviceResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const o = (body ?? {}) as Record<string, unknown>;
  const result = await getStayService().createPresent(actor, {
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    reservationId: typeof o.reservationId === 'string' ? o.reservationId : undefined,
    receptionId: typeof o.receptionId === 'string' ? o.receptionId : undefined,
  });
  return serviceResponse(result, 201);
}
