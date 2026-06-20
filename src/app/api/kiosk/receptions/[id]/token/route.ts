import { NextResponse } from 'next/server';
import { getReception } from '@/lib/mock-backend/reception-store';
import { getVonageSessionService } from '@/lib/call/adapter-factory';
import { getVonagePublicConfig } from '@/lib/call/vonage-config';

/**
 * GET /api/kiosk/receptions/:id/token — 受付端末（publisher）向けの短命トークンを発行する
 * (issue #4 increment 2)。
 *
 * クライアントへ渡すのは applicationId / sessionId / 短命 token のみ（secret は渡さない）。
 * Vonage 無効時や通話セッション未確立時は 409 を返す（受付フローはフォールバックで継続）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const found = await getReception(id);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }

  const service = getVonageSessionService();
  const publicConfig = getVonagePublicConfig();
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
