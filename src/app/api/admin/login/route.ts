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
      // 公開エンドポイントのため内部の設定状態を本文に出さない（レビュー#7）。詳細はサーバログへ。
      console.error('[auth] cognito provider selected but COGNITO_* is incomplete');
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
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
      // 失敗理由を適切な HTTP に写す。資格情報誤りのみ 401。一時障害を 401 に偽装しない（レビュー#1/#3）。
      if (login.reason === 'password_change_required') {
        return NextResponse.json({ error: 'password_change_required' }, { status: 409 });
      }
      if (login.reason === 'challenge_required') {
        return NextResponse.json({ error: 'challenge_required' }, { status: 409 });
      }
      if (login.reason === 'error') {
        // throttle / network / 5xx 等の一時障害。認証失敗と区別する。
        return NextResponse.json({ error: 'unavailable' }, { status: 503 });
      }
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
