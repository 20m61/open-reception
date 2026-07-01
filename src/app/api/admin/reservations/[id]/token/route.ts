import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getReservationService } from '@/lib/reservation/store';
import {
  readScope,
  resolveAdminActor,
  serviceResponse,
  toReservationId,
} from '@/lib/reservation/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/reservations/:id/token — QR トークンを再発行する (issue #97)。
 * 新しい token と有効期限を発行し、旧トークンを無効化する（同一レコードに上書き）。
 * 受け入れ条件「QR 再発行時に旧トークンを失効できる」「再発行が監査に残る」に対応。
 *
 * body: { tenantId, siteId, expiresAt }（expiresAt 省略時は現状の有効期限を維持）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const reservationId = toReservationId(id);

  const svc = getReservationService();
  const o = (body ?? {}) as Record<string, unknown>;
  let expiresAt = typeof o.expiresAt === 'string' ? o.expiresAt : undefined;
  if (!expiresAt) {
    const current = await svc.get(actor, scope.tenantId, scope.siteId, reservationId);
    if (!current.ok) return serviceResponse(current);
    expiresAt = current.value.expiresAt;
  }
  const result = await svc.reissueToken(
    actor,
    scope.tenantId,
    scope.siteId,
    reservationId,
    expiresAt,
  );
  return serviceResponse(result);
}
