import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * 受付端末（kiosk）セッションを要求する共通サーバガード (issue #239)。
 *
 * `/kiosk` の受付フロー（受付セッションの作成・状態遷移）は端末からの操作であり、有効な
 * kiosk セッション必須にする。クライアント側ゲート（`resolveKioskGate`）は UX 誘導であって
 * 実アクセス制御ではないため、各 API ハンドラの処理本体の前にこのガードを通す。
 *
 * セッションが無ければ 403 を返す（呼び出し側は早期 return する）。あれば `null` を返し処理続行。
 */
export async function denyWithoutKioskSession(): Promise<NextResponse | null> {
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(cookie);
  if (session) return null;
  return NextResponse.json(
    { error: 'forbidden', message: 'kiosk session required' },
    { status: 403 },
  );
}
