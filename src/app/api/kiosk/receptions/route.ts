import { NextResponse } from 'next/server';
import { createReception } from '@/lib/data-stores/reception-store';
import { toResponse } from '@/lib/data-stores/http';
import { requireKioskSession } from '@/lib/kiosk/session-guard';

/**
 * POST /api/kiosk/receptions — 受付セッションを作成する (issue #16)。
 * 目的・呼び出し先・来訪者情報が揃った状態で受付を確定開始する。
 * kiosk セッション必須 (issue #239): 未エンロール端末からの受付開始を実アクセス制御で塞ぐ。
 *
 * `reception.kioskId` は認証済み kiosk セッション（cookie）を権威として確定する。クライアント
 * 送信値は信用せず常に上書きする (issue #348)。これを怠ると、送信値と実セッションの kioskId が
 * 食い違った場合に `reception.kioskId` と `session.kioskId` が一致せず、以後の所有権チェック
 * （`.../status`・`/api/kiosk/stay`、issue #342）が正当な同一端末の要求まで 403 にしてしまう。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'invalid JSON' }, { status: 400 });
  }
  const input =
    typeof body === 'object' && body !== null
      ? { ...(body as Record<string, unknown>), kioskId: session.kioskId }
      : body;
  return toResponse(await createReception(input), 201);
}
