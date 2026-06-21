import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { ENTRA_STATE_COOKIE, ENTRA_TOKEN_COOKIE, ENTRA_VERIFIER_COOKIE } from '@/lib/auth/admin';
import { exchangeCodeForToken } from '@/lib/auth/entra-oidc';
import { createJwksResolver, verifyEntraToken } from '@/lib/auth/entra';

/**
 * GET /api/admin/auth/entra/callback — Entra ID からの認可コードを PKCE でトークンへ交換する (issue #70)。
 * 取得したアクセストークンは検証し、許可ロールを持つ場合のみ httpOnly cookie に保持して /admin へ。
 * secret/トークンはレスポンス本文に出さない（cookie のみ）。
 *
 * 堅牢化:
 *   - cookie 読み出しは NextRequest.cookies（パーサ実装）で行う（脆い正規表現を廃止）。
 *   - state は固定長比較で照合（不一致は理由を漏らさず invalid_state にまとめる）。
 *   - Entra が ?error= を返した場合（ユーザー拒否等）はその理由を保持して導く。
 */
function loginError(origin: string, reason: string): NextResponse {
  return NextResponse.redirect(`${origin}/admin/login?error=${encodeURIComponent(reason)}`);
}

/** state の定数時間風比較（長さ不一致は即 false、内容差は XOR で集約）。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = getAdminAuthConfig();
  const url = new URL(request.url);
  const origin = url.origin;
  if (cfg.provider !== 'entra' || !cfg.entra?.clientId) {
    return NextResponse.json({ error: 'entra_not_configured' }, { status: 404 });
  }

  // Entra 側エラー（同意拒否・設定不備など）を尊重して導線へ反映する。
  const idpError = url.searchParams.get('error');
  if (idpError) return loginError(origin, idpError);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = request.cookies.get(ENTRA_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(ENTRA_VERIFIER_COOKIE)?.value;

  if (!code || !state || !verifier || !cookieState || !safeEqual(state, cookieState)) {
    return loginError(origin, 'invalid_state');
  }

  const redirectUri = `${origin}/api/admin/auth/entra/callback`;
  const tokens = await exchangeCodeForToken({
    issuer: cfg.entra.issuer,
    clientId: cfg.entra.clientId,
    redirectUri,
    code,
    codeVerifier: verifier,
  });

  const accessToken = tokens.access_token;
  if (!accessToken) return loginError(origin, 'token_exchange_failed');

  // 取得トークンを検証し、許可ロールを確認してから cookie を発行する。
  const result = await verifyEntraToken(accessToken, {
    issuer: cfg.entra.issuer,
    audience: cfg.entra.audience,
    allowedRoles: cfg.entra.allowedRoles,
    getKey: createJwksResolver(cfg.entra.jwksUri),
  });
  if (!result.ok) return loginError(origin, 'unauthorized');

  const res = NextResponse.redirect(`${origin}/admin`);
  const secure = url.protocol === 'https:';
  res.cookies.set(ENTRA_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: tokens.expires_in ?? 3600,
  });
  // 使い捨ての PKCE cookie を破棄する。
  res.cookies.set(ENTRA_VERIFIER_COOKIE, '', { path: '/', maxAge: 0 });
  res.cookies.set(ENTRA_STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
