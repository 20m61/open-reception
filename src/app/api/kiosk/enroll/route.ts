import { NextResponse } from 'next/server';
import { readJson } from '@/lib/mock-backend/result-http';
import { getDeviceService } from '@/lib/tenant/store';
import { readEnrollmentToken } from '@/lib/auth/kiosk-enrollment';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import type { ConsumeFailure } from '@/lib/tenant/device-service';

/**
 * POST /api/kiosk/enroll — 受付 URL/QR のエンロールトークンを kiosk セッションに交換する
 * (docs/reception-issuance-design.md inc1)。
 *
 * 受付端末自身のパス。管理 actor は介在しないため認可しない（kiosk authorize と同様）。
 * 守りは署名検証・単回性（jti 消費）・端末状態（revoked 拒否）。
 * セキュリティ: token をレスポンス・ログに残さない。成功時のみ httpOnly な長期 kiosk session を設定する。
 */
const FAILURE_STATUS: Record<ConsumeFailure, number> = {
  not_found: 404,
  used: 409,
  revoked: 403,
};

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : undefined;

  const claims = await readEnrollmentToken(token);
  if (!claims) {
    return NextResponse.json(
      { error: 'invalid_token', message: 'enrollment url is invalid or expired' },
      { status: 400 },
    );
  }

  const result = await getDeviceService().consumeEnrollment(claims);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, message: `enrollment ${result.reason}` },
      { status: FAILURE_STATUS[result.reason] },
    );
  }

  const session = await issueKioskSession(result.kioskId);
  const res = NextResponse.json({ ok: true, kioskId: result.kioskId });
  res.cookies.set(KIOSK_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: Math.floor(KIOSK_SESSION_TTL_MS / 1000),
  });
  return res;
}
