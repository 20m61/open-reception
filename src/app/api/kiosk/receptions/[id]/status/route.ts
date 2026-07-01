import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getReception, getReceptionVisitorStatus } from '@/lib/data-stores/reception-store';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * GET /api/kiosk/receptions/:id/status — 受付端末が来訪者向けの状態を取得する
 * (issue #99 increment 1)。担当者の応答アクション結果を短時間ポーリングで反映するために使う。
 *
 * 返すのは受付状態と担当者の最新応答（来訪者向けメッセージ含む）のみ。来訪者の PII は返さない。
 *
 * 認可は token ルートと同じ: 有効な kiosk セッションを必須とし、対象 reception を作成した
 * 端末（reception.kioskId）からの要求に限定する。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const kioskCookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(kioskCookie);
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }

  const found = await getReception(id);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }
  if (found.value.kioskId !== session.kioskId) {
    return NextResponse.json({ error: 'forbidden', message: 'reception belongs to another kiosk' }, { status: 403 });
  }

  const status = await getReceptionVisitorStatus(id);
  // getReception で存在確認済みのため status は ok。型の都合で防御的に分岐する。
  if (!status.ok) {
    return NextResponse.json({ error: status.error.code, message: status.error.message }, { status: 404 });
  }
  return NextResponse.json(status.value);
}
