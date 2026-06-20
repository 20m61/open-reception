import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getReservationService } from '@/lib/reservation/store';
import {
  readScope,
  resolveAdminActor,
  serviceResponse,
  toReservationId,
} from '@/lib/reservation/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/reservations/:id/revoke — 予約/トークンを失効する (issue #97)。
 * 受け入れ条件「失効済みを区別できる」「失効が監査に残る」に対応。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getReservationService().revoke(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
  );
  return serviceResponse(result);
}
