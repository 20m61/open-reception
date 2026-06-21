import { NextResponse } from 'next/server';
import { setKioskEnabled } from '@/lib/kiosk/kiosk-store';
import { resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * POST /api/admin/kiosks/:id/restore — 失効した端末を再有効化する (issue #18)。
 *
 * 認可（#91 inc2）: `requireActor` + `assertCanWrite`（viewer は 403）。
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
  const result = await setKioskEnabled(id, true);
  if (result.ok) await appendAdminAudit('kiosk.restored', { type: 'kiosk', id });
  return resultResponse(result);
}
