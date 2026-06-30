import type { NextResponse } from 'next/server';
import { cancelReception } from '@/lib/mock-backend/reception-store';
import { toResponse } from '@/lib/mock-backend/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/cancel — 来訪者によるキャンセル (issue #16)。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  return toResponse(await cancelReception(id));
}
