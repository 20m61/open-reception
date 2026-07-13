import { NextResponse } from 'next/server';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { requireKioskSession } from '@/lib/kiosk/session-guard';
import { getKioskMotions } from '@/lib/motion/motion-store';

/**
 * GET /api/kiosk/motions — 受付端末向けの状態別モーション URL (issue #31)。
 * VRM レンダラ（#5）が受付状態に応じて再生するために消費する。未設定/失敗時は default に fallback。
 *
 * #290: 機能フラグ `avatarReception` が無効なテナントでは、応答スキーマ `{ motions, defaultUrl? }`
 * を保ったまま空集合を返す（クライアントはアバター静止/無しで継続する）。テナントは kiosk セッションの
 * kioskId から解決する（未セッション時は既定テナント）。
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!(await isKioskFeatureEnabled('avatarReception', session?.kioskId))) {
    return NextResponse.json({ motions: {} });
  }
  return NextResponse.json(await getKioskMotions());
}
