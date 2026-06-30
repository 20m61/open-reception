import { NextResponse } from 'next/server';
import { signSession } from '@/lib/auth/session';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_MS,
  ENTRA_TOKEN_COOKIE,
  getAdminPassword,
  getAdminSecret,
} from '@/lib/auth/admin';
import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { cognitoSrpLogin } from '@/lib/auth/cognito-srp';
import { createJwksResolver, verifyOidcToken } from '@/lib/auth/entra';

/**
 * POST /api/admin/login — 管理ログイン (issue #24 / #70 / #238)。
 *
 * - provider=none   : 管理パスワードを検証し署名付き管理セッション cookie を発行。
 * - provider=cognito: 自前フォームの {username,password} を SRP で認証（Hosted UI 不使用）。
 *   Cognito ID トークンを汎用 OIDC 検証（role/allowedRoles）し SSO cookie に格納。
 * - provider=entra  : リダイレクトログインを使うためパスワード API は無効（409）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const cfg = getAdminAuthConfig();
  const isHttps = new URL(request.url).protocol === 'https:';

  if (cfg.provider === 'entra') {
    return NextResponse.json(
      { error: 'password_login_disabled', message: 'Entra ID ログインを使用してください。' },
      { status: 409 },
    );
  }

  if (cfg.provider === 'cognito') {
    if (!cfg.cognito?.userPoolId || !cfg.cognito.clientId || !cfg.cognito.region) {
      return NextResponse.json(
        { error: 'misconfigured', message: 'Cognito 設定が不足しています。' },
        { status: 500 },
      );
    }
    const body = (await request.json().catch(() => null)) as
      | { username?: unknown; password?: unknown }
      | null;
    const username = typeof body?.username === 'string' ? body.username : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!username || !password) {
      return NextResponse.json({ error: 'unauthorized', message: 'invalid credentials' }, { status: 401 });
    }

    const login = await cognitoSrpLogin(username, password, {
      region: cfg.cognito.region,
      userPoolId: cfg.cognito.userPoolId,
      clientId: cfg.cognito.clientId,
    });
    if (!login.ok) {
      // challenge_required（MFA 等）/ invalid_credentials / error はすべて汎用 401 に丸める
      // （詳細は client に出さない。MFA は inc2 で対応）。
      return NextResponse.json({ error: 'unauthorized', message: 'invalid credentials' }, { status: 401 });
    }

    // ID トークンを検証し、管理ロール（cognito:groups → allowedRoles）を満たすことを確認する。
    const verified = await verifyOidcToken(login.idToken, {
      issuer: cfg.cognito.issuer,
      audience: cfg.cognito.audience,
      allowedRoles: cfg.cognito.allowedRoles,
      getKey: createJwksResolver(cfg.cognito.jwksUri),
      rolesClaim: cfg.cognito.rolesClaim,
    });
    if (!verified.ok) {
      return NextResponse.json({ error: 'forbidden', message: 'not authorized' }, { status: 403 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(ENTRA_TOKEN_COOKIE, login.idToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isHttps,
      maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
    });
    return res;
  }

  // provider=none: 既存パスワード認証。
  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string' || body.password !== getAdminPassword()) {
    return NextResponse.json({ error: 'unauthorized', message: 'invalid password' }, { status: 401 });
  }
  const exp = Date.now() + ADMIN_SESSION_TTL_MS;
  const token = await signSession({ role: 'admin', exp }, getAdminSecret());
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // https のときのみ Secure。http のローカル/検証でも cookie が機能する。
    secure: isHttps,
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return res;
}
