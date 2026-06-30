import type { NextResponse } from 'next/server';
import { markConnected } from '@/lib/mock-backend/reception-store';
import { toResponse } from '@/lib/mock-backend/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/connected — 非同期通話で担当者が応答した (issue #4 increment 2)。
 * 受付状態を calling → connected に確定する。クライアント（通話接続検知）から呼ぶ。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  const { id } = await params;
  return toResponse(await markConnected(id));
}
