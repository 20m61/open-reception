import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * GET /api/kiosk/heartbeat?kioskId=... — 受付端末の定期確認 (issue #30)。
 * 端末有効性（失効/緊急停止）と許可状態を返し、長期表示中の変化を検知できるようにする。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = await getKioskConfig(kioskId);
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  return NextResponse.json({
    active: effectiveKioskActive(config.active, security.emergencyStop),
    pinRequired: security.pinRequired,
    authorized: session !== null,
    serverTime: new Date().toISOString(),
  });
}
