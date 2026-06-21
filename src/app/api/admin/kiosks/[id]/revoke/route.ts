import { NextResponse } from 'next/server';
import { setKioskEnabled } from '@/lib/kiosk/kiosk-store';
import { resultResponse } from '@/lib/mock-backend/result-http';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { recordDangerAction } from '@/lib/admin/audit';

/**
 * POST /api/admin/kiosks/:id/revoke — 端末を失効する (issue #18, #23)。
 * 失効後、受付端末は config で active=false を受け取り受付を停止する。
 *
 * 認可（#91 inc2）: 端末失効は危険操作。`requireActor` + `assertCanWrite`（viewer は 403）。
 * 監査（#91）: 既存 AuditAction `kiosk.revoked` を `recordDangerAction` で記録する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const result = await setKioskEnabled(id, false);
  if (result.ok) await recordDangerAction({ action: 'kiosk.revoked', target: { type: 'kiosk', id } });
  return resultResponse(result);
}
