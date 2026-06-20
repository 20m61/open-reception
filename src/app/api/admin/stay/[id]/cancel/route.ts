import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getStayService } from '@/lib/visit/store';
import { readScope, resolveAdminActor, serviceResponse, toStayId } from '@/lib/visit/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/stay/:id/cancel — 在館記録を取り消す（誤登録の訂正） (issue #102)。
 * present 以外からは遷移しない（409）。取消を監査に残す（PII なし）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getStayService().cancel(actor, scope.tenantId, scope.siteId, toStayId(id));
  return serviceResponse(result);
}
