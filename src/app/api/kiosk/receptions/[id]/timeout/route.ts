import type { NextResponse } from 'next/server';
import { markTimeout } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { requireOwnedReception } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/timeout — 非同期通話が未応答だった (issue #4 increment 2)。
 * 受付状態を calling → timeout に確定し、受付履歴を記録する。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const owned = await requireOwnedReception(id);
  if (!owned.ok) return owned.response;
  return toResponse(await markTimeout(id));
}
