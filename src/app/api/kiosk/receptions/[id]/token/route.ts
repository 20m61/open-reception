import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getReception } from '@/lib/data-stores/reception-store';
import { resolveVonageSessionService } from '@/lib/call/adapter-factory';
import { getVonagePublicConfigForTenant } from '@/lib/call/vonage-config';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';

/**
 * GET /api/kiosk/receptions/:id/token — 受付端末（publisher）向けの短命トークンを発行する
 * (issue #4 increment 2)。
 *
 * クライアントへ渡すのは applicationId / sessionId / 短命 token のみ（secret は渡さない）。
 * Vonage 無効時や通話セッション未確立時は 409 を返す（受付フローはフォールバックで継続）。
 *
 * 認可 (increment 2b): 有効な kiosk セッションを必須とし、対象 reception を作成した端末
 * （reception.kioskId）からの要求に限定する。第三者が reception id を知っていても発行不可。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // kiosk セッション必須（管理 API ではなく端末からの要求であることを担保）。
  const kioskCookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(kioskCookie);
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

  // テナント/サイト境界は営業時間ガード/routing と同じ既定スコープ規則で解決する（単一テナント既定）。
  const { tenantId } = resolveDefaultScope();
  const service = await resolveVonageSessionService(tenantId);
  const publicConfig = await getVonagePublicConfigForTenant(tenantId);
  const sessionId = found.value.vonageSessionId;
  if (!service || !publicConfig || !sessionId) {
    return NextResponse.json(
      { error: 'unavailable', message: 'vonage call session is not available' },
      { status: 409 },
    );
  }

  const token = await service.issueToken({ sessionId }, 'publisher');
  return NextResponse.json({
    applicationId: publicConfig.applicationId,
    sessionId,
    token: token.token,
    role: token.role,
    expiresAt: token.expiresAt,
  });
}
