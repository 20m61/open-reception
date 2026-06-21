import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { getDeviceService } from '@/lib/tenant/store';

/**
 * GET /api/kiosk/heartbeat?kioskId=... — 受付端末の定期確認 (issue #30)。
 * 端末有効性（失効/緊急停止）と許可状態を返し、長期表示中の変化を検知できるようにする。
 *
 * Kiosk→Device 統合 (issue #87 inc3): この heartbeat を Device.lastSeenAt に反映し、
 * 管理画面（/admin/devices・/admin/sites）の稼働状態を実活動から導く。対応 Device が無い
 * kiosk は no-op。記録は best-effort で、失敗しても heartbeat 応答は止めない。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = await getKioskConfig(kioskId);
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  // Device の lastSeenAt 更新は heartbeat 応答に影響させない（best-effort）。
  try {
    await getDeviceService().recordHeartbeat(kioskId);
  } catch {
    // Device 統合は補助的な read 経路。失敗しても端末の動作確認は継続する。
  }
  return NextResponse.json({
    active: effectiveKioskActive(config.active, security.emergencyStop),
    pinRequired: security.pinRequired,
    authorized: session !== null,
    serverTime: new Date().toISOString(),
  });
}
