import type { NextResponse } from 'next/server';
import { startCall } from '@/lib/mock-backend/reception-store';
import { toResponse } from '@/lib/mock-backend/http';

/**
 * POST /api/kiosk/receptions/:id/call — 呼び出しを開始する (issue #16, #20)。
 * mock adapter の結果に応じて connected / timeout / failed へ確定する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return toResponse(await startCall(id));
}
