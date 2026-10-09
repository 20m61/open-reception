import { NextResponse } from 'next/server';
import { getReception } from '@/lib/data-stores/reception-store';
import { resolveVonageSessionAccess } from '@/lib/call/vonage-session-access';
import { requireKioskSession } from '@/lib/kiosk/session-guard';

/**
 * GET /api/kiosk/receptions/:id/token — 受付端末（publisher）向けの短命トークンを発行する
 * (issue #4 increment 2)。
 *
 * クライアントへ渡すのは applicationId / sessionId / 短命 token のみ（secret は渡さない）。
 * Vonage 無効時や通話セッション未確立時は 409 を返す（受付フローはフォールバックで継続）。
 *
 * 認可 (increment 2b): 有効な kiosk セッションを必須とし、対象 reception を作成した端末
 * （reception.kioskId）からの要求に限定する。第三者が reception id を知っていても発行不可。
 *
 * トークンはセッションを作ったテナントの Vonage 設定で発行する（`lib/call/vonage-session-access.ts`）。
 * 端末の現在の所属テナントがそれと違えば 404（存在しない受付と同じ応答）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // kiosk セッション必須（管理 API ではなく端末からの要求であることを担保）。
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }

  const found = await getReception(id);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }
  // 対象受付を作成した端末からの要求に限定する。
  if (found.value.kioskId !== session.kioskId) {
    return NextResponse.json({ error: 'forbidden', message: 'reception belongs to another kiosk' }, { status: 403 });
  }

  // Vonage の設定はセッションの所有テナント（作成時に記録）から引く。端末の現在の所属
  // テナントが違えば（作成後に別テナントへ移った等）発行しない。
  const access = await resolveVonageSessionAccess(found.value, session.tenantId);
  if (access.kind === 'mismatch') {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }
  if (access.kind === 'unavailable') {
    return NextResponse.json(
      { error: 'unavailable', message: 'vonage call session is not available' },
      { status: 409 },
    );
  }
  const { service, sessionId } = access;

  const token = await service.issueToken({ sessionId }, 'publisher');
  return NextResponse.json({
    applicationId: access.applicationId,
    sessionId,
    token: token.token,
    role: token.role,
    expiresAt: token.expiresAt,
  });
}
