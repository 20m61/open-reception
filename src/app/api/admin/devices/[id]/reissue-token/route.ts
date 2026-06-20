import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { asDeviceId } from '@/domain/tenant/types';
import { getDeviceService } from '@/lib/tenant/store';
import { readTenantScope, resolveAdminActor, serviceResponse } from '@/lib/tenant/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/devices/:id/reissue-token — 端末 token を再発行する (issue #87 inc2)。
 *
 * 危険操作。UI 側で確認ダイアログを必須にする。
 * 認可: サイト write（service 層 #80 認可）。viewer 不可・テナント越境拒否。
 * セキュリティ: token の平文は **レスポンスにも監査にも残さない**（tokenRegistered の真偽のみ）。
 * 監査: device.token_reissued（metadata は id/name/siteId/status のみ）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const scope = readTenantScope(body ?? {});
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getDeviceService().reissueToken(actor, scope.tenantId, asDeviceId(id));
  return serviceResponse(result);
}
