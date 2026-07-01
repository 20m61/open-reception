import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getStayService } from '@/lib/visit/store';
import { readScope, resolveAdminActor, serviceResponse, toStayId } from '@/lib/visit/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/stay/:id/checkout — 在館者を退館済みにする (issue #102)。
 * 二重退館は 409（present 以外からは遷移しない）。退館を監査に残す（PII なし）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getStayService().checkOut(actor, scope.tenantId, scope.siteId, toStayId(id));
  return serviceResponse(result);
}
