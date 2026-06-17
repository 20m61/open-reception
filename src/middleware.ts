import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { ADMIN_COOKIE, getAdminSecret } from '@/lib/auth/admin';

/**
 * 認可境界 (issue #24)。
 * - /admin/* と /api/admin/* は管理セッション必須。
 * - kiosk（管理 cookie を持たない）からは管理画面/APIへアクセスできない。
 * - 認証エントリ（/admin/login, /api/admin/login）は公開。
 */
const PUBLIC_PATHS = new Set<string>(['/admin/login', '/api/admin/login']);

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const isAdminApi = pathname.startsWith('/api/admin');
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!isAdminApi && !isAdminPage) return NextResponse.next();

  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  const session = await verifySession(token, getAdminSecret());
  if (session) return NextResponse.next();

  if (isAdminApi) {
    return NextResponse.json({ error: 'unauthorized', message: 'admin authentication required' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/admin/login';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/admin', '/admin/:path*', '/api/admin/:path*'],
};
