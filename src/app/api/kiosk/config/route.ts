import { NextResponse } from 'next/server';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';

/**
 * GET /api/kiosk/config?kioskId=... — 受付端末の設定取得 (issue #18)。
 * 失効・未登録端末は active=false を返し、受付端末は受付開始を停止する。
 */
export function GET(request: Request): NextResponse {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  return NextResponse.json(getKioskConfig(kioskId));
}
