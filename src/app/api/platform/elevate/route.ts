import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { grantElevation, elevationAuditMetadata } from '@/domain/auth/elevation';
import { recordDangerAction } from '@/lib/admin/audit';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { ELEVATION_COOKIE, issueElevationToken } from '@/lib/platform/elevation';
import { reauthenticate, type ReauthProvider } from '@/lib/platform/reauth';

/**
 * POST /api/platform/elevate — JIT 昇格の発行 (issue #83 AC5/AC10 / inc4b)。
 *
 * developer が**理由 + 再認証**を経て、期限付き（既定 30 分・platform 全体スコープ）の昇格を得る。
 * 成功時に短命署名 cookie `platform_elevation` を Set-Cookie し、以降の破壊的操作を assertElevated で
 * 解禁する。理由・発行/否認は監査に残す（credential/OTP は残さない）。
 *
 * 再認証は interface + mock 先行（`PLATFORM_REAUTH_MOCK` 設定時のみ mock 有効。実 Cognito TOTP は #65）。
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;
  const actor = `platform:${auth.identity}`; // 監査/cookie の操作者識別（#264）。

  const body = (await request.json().catch(() => ({}))) as {
    reason?: unknown;
    provider?: unknown;
    credential?: unknown;
  };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  const provider: ReauthProvider = body.provider === 'cognito' ? 'cognito' : 'none';
  const credential = typeof body.credential === 'string' ? body.credential : '';

  const reauth = await reauthenticate(provider, credential);
  if (!reauth.ok) {
    // 否認を監査（理由は残すが credential は残さない）。
    await recordDangerAction({
      action: 'auth.reauthenticated',
      target: { type: 'platform' },
      reason,
      metadata: { result: 'denied', why: reauth.reason },
      actor,
      request,
    });
    return NextResponse.json({ error: 'reauth_failed', reason: reauth.reason }, { status: 403 });
  }

  // inc4b は platform 全体スコープ（{}）。テナント限定昇格は後続。
  const now = Date.now();
  const elevation = grantElevation({ reason, scope: {} }, now);
  const token = await issueElevationToken(elevation, randomUUID(), auth.identity);

  await recordDangerAction({
    action: 'privilege.elevated',
    target: { type: 'platform' },
    reason,
    metadata: elevationAuditMetadata(elevation),
    actor,
    request,
  });

  // Secure は admin セッション cookie（login/route.ts）と同じくリクエストプロトコルで判定する
  // （NODE_ENV はデプロイ実行の信頼できる指標ではないため）。maxAge は grant と同一 `now` から導く。
  const isHttps = new URL(request.url).protocol === 'https:';
  const res = NextResponse.json({ ok: true, until: elevation.until });
  res.cookies.set(ELEVATION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps,
    path: '/',
    maxAge: Math.max(0, Math.floor((elevation.until - now) / 1000)),
  });
  return res;
}
