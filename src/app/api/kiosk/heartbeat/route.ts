import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getKiosk, getKioskConfig } from '@/lib/kiosk/kiosk-store';
import { getSecuritySettings } from '@/lib/security/security-store';
import { effectiveKioskActive } from '@/domain/security/types';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { getDeviceService } from '@/lib/tenant/store';

/**
 * GET /api/kiosk/heartbeat?kioskId=... — 受付端末の定期確認 (issue #30)。
 * 端末有効性（失効/緊急停止）と許可状態を返し、長期表示中の変化を検知できるようにする。
 *
 * Kiosk→Device 統合 (issue #87 inc3): この heartbeat を Device.lastSeenAt に反映し、
 * 管理画面（/admin/devices・/admin/sites）や死活集計 (#261) の稼働状態を実活動から導く。
 * 対応 Device が無い kiosk（旧レジストリのみの端末）は、kiosk レジストリでの実在を確認して
 * Device へ取り込む（#261: Device を source-of-truth へ寄せる片方向同期。未登録 id は
 * 取り込まないため、無認可 heartbeat からの任意行作成にはならない）。
 *
 * false-offline 方針 (#261): 記録は best-effort（30 秒間隔）で、失敗しても heartbeat 応答は
 * 止めない。オンライン窓は 5 分（DEFAULT_ONLINE_WINDOW_MS）= 10 周期分あり、単発の書込失敗は
 * 次周期が実質リトライとなって false-offline にならない。即時リトライは持たない。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = await getKioskConfig(kioskId);
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  // Device の lastSeenAt 更新・取り込みは heartbeat 応答に影響させない（best-effort）。
  try {
    const service = getDeviceService();
    const { matched } = await service.recordHeartbeat(kioskId);
    // 空 id はストアを引かない（DynamoDB は空の SK を拒否する。getKioskConfig と同じ規約）。
    if (!matched && kioskId.trim() !== '') {
      const kiosk = await getKiosk(kioskId);
      if (kiosk.ok) {
        await service.adoptKiosk(
          {
            id: kiosk.value.id,
            displayName: kiosk.value.displayName,
            ...(kiosk.value.location !== undefined ? { location: kiosk.value.location } : {}),
            enabled: kiosk.value.enabled,
          },
          resolveDefaultScope(),
        );
      }
    }
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
