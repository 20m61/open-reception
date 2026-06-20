import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getReservationService } from '@/lib/reservation/store';
import {
  parseEditBody,
  readScope,
  resolveAdminActor,
  serviceResponse,
  toReservationId,
} from '@/lib/reservation/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/reservations/:id?tenantId=&siteId= — 単一予約取得 (issue #97)。
 * PATCH  /api/admin/reservations/:id — 予約編集（active のみ）。
 * DELETE /api/admin/reservations/:id — 予約キャンセル（active → cancelled）。
 *
 * 認証/認可/監査は service 層で #80 認可と PII なし監査を適用する。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReservationService().get(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
  );
  return serviceResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReservationService().edit(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
    parseEditBody(body),
  );
  return serviceResponse(result);
}

export async function DELETE(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReservationService().cancel(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
  );
  return serviceResponse(result);
}
