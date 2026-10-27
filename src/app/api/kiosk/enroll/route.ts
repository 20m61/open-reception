import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getDeviceService } from '@/lib/tenant/store';
import { getEnrollmentSecret, readEnrollmentToken } from '@/lib/auth/kiosk-enrollment';
import { secretUnavailableResponse } from '@/lib/auth/secret-unavailable';
import { KIOSK_COOKIE, KIOSK_SESSION_TTL_MS, issueKioskSession } from '@/lib/auth/kiosk';
import {
  KIOSK_DEVICE_COOKIE,
  KIOSK_DEVICE_COOKIE_PATH,
  KIOSK_DEVICE_CREDENTIAL_TTL_MS,
  issueDeviceCredential,
} from '@/lib/auth/kiosk-device-credential';
import type { ConsumeFailure } from '@/lib/tenant/device-service';

/**
 * POST /api/kiosk/enroll — 受付 URL/QR のエンロールトークンを kiosk セッションに交換する
 * (docs/reception-issuance-design.md inc1)。
 *
 * 受付端末自身のパス。管理 actor は介在しないため認可しない（kiosk authorize と同様）。
 * 守りは署名検証・単回性（jti 消費）・端末状態（revoked 拒否）。
 * セキュリティ: token をレスポンス・ログに残さない。成功時のみ httpOnly な長期 kiosk session を設定する。
 *
 * 成功時は**端末証明**（`kiosk_device`、1 年）も併せて設定する (#1237)。セッションが切れたあと、
 * PIN 画面から再認可できるのはこの証明を持つ（＝ここで登録した）端末だけである。
 */
const FAILURE_STATUS: Record<ConsumeFailure, number> = {
  not_found: 404,
  used: 409,
  revoked: 403,
};

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { token?: unknown } | null;
  const token = typeof body?.token === 'string' ? body.token : undefined;

  // 🔴 鍵未設定デプロイで uncaught にしない。**catch の射程は鍵の解決だけ**
  // （理由と、広げたときに何が壊れるかは `src/lib/auth/secret-unavailable.ts` に 1 度だけ書く）。
  // 射程は route テストの「鍵以外の throw は 503 に化けない」が縛る (#1123)。
  try {
    getEnrollmentSecret();
  } catch {
    return secretUnavailableResponse('KIOSK_ENROLLMENT_SECRET');
  }
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
  const credential = await issueDeviceCredential(result.kioskId, result.credentialGeneration);
  const secure = new URL(request.url).protocol === 'https:';
  const res = NextResponse.json({ ok: true, kioskId: result.kioskId });
  res.cookies.set(KIOSK_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: Math.floor(KIOSK_SESSION_TTL_MS / 1000),
  });
  // 🔴 path は authorize に限る（証明を使うのは PIN 再認可だけ。他の要求に載せない）。
  res.cookies.set(KIOSK_DEVICE_COOKIE, credential, {
    httpOnly: true,
    sameSite: 'strict',
    path: KIOSK_DEVICE_COOKIE_PATH,
    secure,
    maxAge: Math.floor(KIOSK_DEVICE_CREDENTIAL_TTL_MS / 1000),
  });
  return res;
}
