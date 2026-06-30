import { NextResponse } from 'next/server';
import { createReception } from '@/lib/mock-backend/reception-store';
import { toResponse } from '@/lib/mock-backend/http';
import { denyWithoutKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions — 受付セッションを作成する (issue #16)。
 * 目的・呼び出し先・来訪者情報が揃った状態で受付を確定開始する。
 * kiosk セッション必須 (issue #239): 未エンロール端末からの受付開始を実アクセス制御で塞ぐ。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = await denyWithoutKioskSession();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'invalid JSON' }, { status: 400 });
  }
  return toResponse(await createReception(body), 201);
}
