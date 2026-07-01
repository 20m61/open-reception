import type { NextResponse } from 'next/server';
import { recordFallback } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/fallback — 失敗/未応答後の代替導線利用 (issue #15, #19)。
 * 受付履歴の fallbackUsed を記録する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  return toResponse(await recordFallback(id));
}
