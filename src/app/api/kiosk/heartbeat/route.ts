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
 *
 * 死活記録のセッション紐づけ (#284 inc1): lastSeenAt 更新・adoptKiosk は、有効な kiosk
 * セッション（cookie）を持ち、かつセッションの kioskId がクエリの kioskId と一致する
 * リクエストに限る。これで kioskId を知るだけの外部者が GET を叩いて「偽 online」を注入する
 * 経路を塞ぐ。セッション無し/不一致は**記録だけをスキップ**し、応答（active/pinRequired/
 * authorized/serverTime）は従来互換のまま返す — 未エンロール端末の失効検知・緊急停止検知や
 * authorized による導線分岐（#239）を壊さないため。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const kioskId = new URL(request.url).searchParams.get('kioskId') ?? '';
  const config = await getKioskConfig(kioskId);
  const security = await getSecuritySettings();
  const token = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(token);
  // Device の lastSeenAt 更新・取り込みは heartbeat 応答に影響させない（best-effort）。
  // 記録はセッションに紐づく端末自身の heartbeat に限定する（#284 inc1。空 id はセッションを
  // 発行しないため一致し得ず、ここで同時に短絡される — DynamoDB の空 SK 回避の既存規約も維持）。
  if (session !== null && session.kioskId === kioskId && kioskId.trim() !== '') {
    try {
      const service = getDeviceService();
      const { matched } = await service.recordHeartbeat(kioskId);
      if (!matched) {
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
  }
  return NextResponse.json({
    active: effectiveKioskActive(config.active, security.emergencyStop),
    pinRequired: security.pinRequired,
    authorized: session !== null,
    serverTime: new Date().toISOString(),
  });
}
