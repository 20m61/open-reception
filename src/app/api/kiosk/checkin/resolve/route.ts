import { NextResponse } from 'next/server';
import { getCheckinService, resolveCheckinScope } from '@/lib/checkin/store';
import { failureResponse, readPayload, requireKioskSession } from '@/lib/checkin/request';

/**
 * POST /api/kiosk/checkin/resolve — QR payload から予約サマリを解決する (issue #98)。
 *
 * 閲覧のみ。**使用済み化・即時呼び出しはしない**（確認画面で来訪者の操作を待つ）。
 * 返すのは確認に必要な最小限のサマリ（token / note / id を含めない）。
 * 通信断（リポジトリ例外）は 503 を返し、受付端末は networkError として扱う。
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
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const payload = readPayload(body);
  if (payload === null) return NextResponse.json({ error: 'invalid' }, { status: 400 });

  // 🔴 端末が台帳に無ければ拒否する。既定テナントへ倒すと**他テナントの予約を引ける**。
  const scope = await resolveCheckinScope(session.kioskId);
  if (!scope) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk is not registered' }, { status: 403 });
  }
  const { tenantId, siteId } = scope;
  try {
    const result = await getCheckinService().resolve(tenantId, siteId, payload);
    if (!result.ok) return failureResponse(result.reason);
    return NextResponse.json({ summary: result.summary });
  } catch {
    // 通信断・バックエンド障害。受付フローは通常受付へフォールバックできる。
    return NextResponse.json({ error: 'network' }, { status: 503 });
  }
}
