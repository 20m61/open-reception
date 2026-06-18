import { NextResponse } from 'next/server';
import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { ENTRA_STATE_COOKIE, ENTRA_VERIFIER_COOKIE } from '@/lib/auth/admin';
import { buildAuthorizeUrl, createCodeChallenge, createCodeVerifier } from '@/lib/auth/entra-oidc';

/**
 * GET /api/admin/auth/entra/start — Entra ID の Authorization Code + PKCE ログインを開始する (issue #70)。
 * Client Secret は使わず（PKCE）、verifier/state は短命 httpOnly cookie に保持する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const cfg = getAdminAuthConfig();
  if (cfg.provider !== 'entra' || !cfg.entra?.issuer || !cfg.entra.clientId) {
    return NextResponse.json({ error: 'entra_not_configured' }, { status: 404 });
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/admin/auth/entra/callback`;
  const verifier = createCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  const state = createCodeVerifier();

  const authorizeUrl = buildAuthorizeUrl({
    issuer: cfg.entra.issuer,
    clientId: cfg.entra.clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    scope: process.env.ENTRA_SCOPE,
  });

  const res = NextResponse.redirect(authorizeUrl);
  const secure = url.protocol === 'https:';
  const opts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure, maxAge: 600 };
  res.cookies.set(ENTRA_VERIFIER_COOKIE, verifier, opts);
  res.cookies.set(ENTRA_STATE_COOKIE, state, opts);
  return res;
}
