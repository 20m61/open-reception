import type { NextResponse } from 'next/server';
import { completeReception } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { requireOwnedReception } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions/:id/complete — 応対完了 (issue #16)。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const owned = await requireOwnedReception(id);
  if (!owned.ok) return owned.response;
  return toResponse(await completeReception(id));
}
