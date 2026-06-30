import type { NextResponse } from 'next/server';
import { markTimeout } from '@/lib/mock-backend/reception-store';
import { toResponse } from '@/lib/mock-backend/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/timeout — 非同期通話が未応答だった (issue #4 increment 2)。
 * 受付状態を calling → timeout に確定し、受付履歴を記録する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  return toResponse(await markTimeout(id));
}
