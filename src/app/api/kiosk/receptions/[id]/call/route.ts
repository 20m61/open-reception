import type { NextResponse } from 'next/server';
import { startCall } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/call — 呼び出しを開始する (issue #16, #20)。
 * mock adapter の結果に応じて connected / timeout / failed へ確定する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  return toResponse(await startCall(id));
}
