import { NextResponse } from 'next/server';
import { ADMIN_COOKIE } from '@/lib/auth/admin';

/**
 * POST /api/admin/logout — 管理セッション cookie を破棄する (issue #24)。
 */
export function POST(): NextResponse {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
