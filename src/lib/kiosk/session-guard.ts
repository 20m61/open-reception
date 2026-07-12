import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * 有効な kiosk セッション（cookie）を返す。無ければ null。
 *
 * kioskId はこの戻り値（認証済みセッション）を権威とする。クライアント送信値（リクエスト
 * body/query の kioskId）は信用しない (issue #348) — 受付作成 (`/api/kiosk/receptions`)
 * はこの kioskId で `reception.kioskId` を確定し、以後の所有権チェック（status/stay 等）が
 * 同一端末からの要求で一致するようにする。
 */
export async function requireKioskSession(): Promise<{ kioskId: string } | null> {
  const cookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  return readKioskSession(cookie);
}

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
  const session = await requireKioskSession();
  if (session) return null;
  return NextResponse.json(
    { error: 'forbidden', message: 'kiosk session required' },
    { status: 403 },
  );
}
