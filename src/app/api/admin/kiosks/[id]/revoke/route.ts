import type { NextResponse } from 'next/server';
import { setKioskEnabled } from '@/lib/kiosk/kiosk-store';
import { resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/kiosks/:id/revoke — 端末を失効する (issue #18, #23)。
 * 失効後、受付端末は config で active=false を受け取り受付を停止する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = setKioskEnabled(id, false);
  if (result.ok) appendAdminAudit('kiosk.revoked', { type: 'kiosk', id });
  return resultResponse(result);
}
