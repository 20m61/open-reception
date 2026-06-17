import { NextResponse } from 'next/server';
import { createKiosk, listKiosks } from '@/lib/kiosk/kiosk-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';

/**
 * GET /api/admin/kiosks — 受付端末一覧 (issue #18)。
 * POST /api/admin/kiosks — 受付端末を登録。
 *
 * NOTE: 認証・認可は middleware（#24）で付与済み。
 */
export function GET(): NextResponse {
  return NextResponse.json({ items: listKiosks() });
}

export async function POST(request: Request): Promise<NextResponse> {
  return resultResponse(createKiosk(await readJson(request)), 201);
}
