import type { NextResponse } from 'next/server';
import { setKioskEnabled } from '@/lib/kiosk/kiosk-store';
import { resultResponse } from '@/lib/mock-backend/result-http';

/**
 * POST /api/admin/kiosks/:id/revoke — 端末を失効する (issue #18, #23)。
 * 失効後、受付端末は config で active=false を受け取り受付を停止する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return resultResponse(setKioskEnabled(id, false));
}
