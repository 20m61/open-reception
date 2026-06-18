import { NextResponse } from 'next/server';
import { signSession } from '@/lib/auth/session';
import { ADMIN_COOKIE, ADMIN_SESSION_TTL_MS, getAdminPassword, getAdminSecret } from '@/lib/auth/admin';
import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';

/**
 * POST /api/admin/login — 管理パスワードを検証し、署名付き管理セッション cookie を発行する (issue #24)。
 * ADMIN_AUTH_PROVIDER=entra のときはパスワード認証を無効化し、Entra ログインへ寄せる (issue #70)。
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (getAdminAuthConfig().provider === 'entra') {
    return NextResponse.json(
      { error: 'password_login_disabled', message: 'Entra ID ログインを使用してください。' },
      { status: 409 },
    );
  }
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
    secure: new URL(request.url).protocol === 'https:',
    maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
  });
  return res;
}
