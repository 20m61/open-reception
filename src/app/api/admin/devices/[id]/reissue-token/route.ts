import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { asDeviceId } from '@/domain/tenant/types';
import { getDeviceService } from '@/lib/tenant/store';
import { readTenantScope, resolveAdminActor, serviceResponse } from '@/lib/tenant/request';
import { resolveCheckinBaseUrl } from '@/lib/reservation/base-url';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/devices/:id/reissue-token — 受付 URL/QR を発行する
 * (issue #87 inc2 → docs/reception-issuance-design.md inc1)。
 *
 * 危険操作。UI 側で確認ダイアログを必須にする。発行のたびに旧 URL は無効化される。
 * 認可: サイト write（service 層 #80 認可）。viewer 不可・テナント越境拒否。
 * セキュリティ: 平文トークンは **このレスポンスでのみ一度だけ**返す（`enrollmentUrl`）。
 *   監査・永続化・再取得には残さない（device.token_reissued の metadata は id/name/siteId/status のみ）。
 * baseUrl はサーバ側で解決し、クライアント送信値は信用しない（resolveCheckinBaseUrl）。
 */
export async function POST(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const scope = readTenantScope(body ?? {});
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const baseUrl = resolveCheckinBaseUrl(request);
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'cannot resolve enrollment base url' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await getDeviceService().issueEnrollment(actor, scope.tenantId, asDeviceId(id));
  if (!result.ok) return serviceResponse(result);

  const enrollmentUrl = `${baseUrl}/kiosk/enroll?token=${encodeURIComponent(result.value.enrollment.token)}`;
  return NextResponse.json({
    device: result.value.view,
    enrollmentUrl,
    expiresAt: result.value.enrollment.expiresAt,
  });
}
