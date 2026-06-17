import { NextResponse } from 'next/server';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';

/**
 * GET /api/kiosk/config?kioskId=... — 受付端末の設定取得 (issue #18, #29)。
 * 失効・未登録端末、または緊急停止中は active=false を返し、受付開始を停止する。
 */
export function GET(request: Request): NextResponse {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = getKioskConfig(kioskId);
  const emergencyStop = getSecuritySettings().emergencyStop;
  return NextResponse.json({ ...config, active: effectiveKioskActive(config.active, emergencyStop) });
}
