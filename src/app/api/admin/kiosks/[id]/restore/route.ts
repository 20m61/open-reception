import type { NextResponse } from 'next/server';
import { setKioskEnabled } from '@/lib/kiosk/kiosk-store';
import { resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/kiosks/:id/restore — 失効した端末を再有効化する (issue #18)。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = await setKioskEnabled(id, true);
  if (result.ok) await appendAdminAudit('kiosk.restored', { type: 'kiosk', id });
  return resultResponse(result);
}
