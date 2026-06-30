import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth/session';
import { ADMIN_COOKIE, ENTRA_TOKEN_COOKIE, getAdminSecret } from '@/lib/auth/admin';
import { getAdminAuthConfig, validateAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { verifyOidcToken, createJwksResolver } from '@/lib/auth/entra';
import { canWrite } from '@/domain/auth/roles';

/**
 * 認可境界 (issue #24, #70)。
 * - /admin/* と /api/admin/* は管理認証必須。受付/キオスク導線は非対象。
 * - 認証方式は ADMIN_AUTH_PROVIDER で切替: none（既存パスワード）/ entra（Entra ID JWT）。
 * - entra 有効時はパスワード認証を置換し、roles claim でロール認可（Viewer は読み取り専用）。
 * - 認証エントリ（/admin/login, /api/admin/login, Entra ログイン導線）は公開。
 */
const PUBLIC_PATHS = new Set<string>([
  '/admin/login',
  '/api/admin/login',
  '/api/admin/auth/entra/start',
  '/api/admin/auth/entra/callback',
]);

/**
 * CloudFront 経由アクセスの検証 (OAC POST 署名問題の回避方式)。
 * Function URL を authType=NONE で公開する代わり、CloudFront が origin custom header
 * `x-origin-verify` に高エントロピーのシークレットを付与する。これと一致しないリクエスト
 * （= Function URL 直叩き / CloudFront 迂回）は全ルートで 403 拒否する。
 * `ORIGIN_VERIFY_SECRET` 未設定（ローカル / OAC 方式）なら検証しない（後方互換）。
 */
const ORIGIN_VERIFY_HEADER = 'x-origin-verify';

function isFromTrustedOrigin(req: NextRequest): boolean {
  const expected = process.env.ORIGIN_VERIFY_SECRET;
  if (!expected) return true;
  // シークレットは高エントロピーのため単純比較で十分（タイミング攻撃は非現実的）。
  return req.headers.get(ORIGIN_VERIFY_HEADER) === expected;
}

/** 状態変更系メソッドか（Viewer に拒否する対象）。 */
function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function denyApiOrRedirect(req: NextRequest, isAdminApi: boolean, status: 401 | 403): NextResponse {
  if (isAdminApi) {
    const message = status === 403 ? 'insufficient role' : 'admin authentication required';
    return NextResponse.json({ error: status === 403 ? 'forbidden' : 'unauthorized', message }, { status });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/admin/login';
  const res = NextResponse.redirect(url);
  // 307 リダイレクト応答にも Content-Type を明示する（ZAP 10019: Content-Type 欠落の解消）。
  res.headers.set('Content-Type', 'text/plain; charset=utf-8');
  return res;
}

/** Server Component（layout）が現在パスを参照できるよう、リクエストヘッダへ pathname を付与する。 */
export const PATHNAME_HEADER = 'x-or-pathname';

function passThrough(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(PATHNAME_HEADER, req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(req: NextRequest): Promise<NextResponse> {
  // CloudFront 迂回（Function URL 直叩き）を全ルートで拒否する（origin-verify 方式時のみ）。
  if (!isFromTrustedOrigin(req)) {
    return new NextResponse('forbidden', { status: 403 });
  }

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return passThrough(req);

  const isAdminApi = pathname.startsWith('/api/admin');
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!isAdminApi && !isAdminPage) return NextResponse.next();

  const cfg = getAdminAuthConfig();

  // 設定不備（本番で認証無効化・entra 必須値欠落）は fail closed で管理を開かない (issue #70)。
  const check = validateAdminAuthConfig(cfg);
  if (!check.ok) {
    return NextResponse.json(
      { error: 'admin_auth_misconfigured', message: check.errors.join(' ') },
      { status: 500 },
    );
  }

  // --- SSO（OIDC JWT: Entra / Cognito）でパスワード認証を置換 ---
  // entra / cognito は SSO トークン Cookie を毎リクエスト汎用 OIDC 検証する（rolesClaim のみ provider 差）。
  const oidc = cfg.provider === 'entra' ? cfg.entra : cfg.provider === 'cognito' ? cfg.cognito : undefined;
  if (oidc) {
    // PoC/ローカルで認証を緩和する設定（本番は config 検証でエラー）。
    if (!cfg.required) return passThrough(req);

    const token = req.cookies.get(ENTRA_TOKEN_COOKIE)?.value;
    if (!token) return denyApiOrRedirect(req, isAdminApi, 401);

    const result = await verifyOidcToken(token, {
      issuer: oidc.issuer,
      audience: oidc.audience,
      allowedRoles: oidc.allowedRoles,
      getKey: createJwksResolver(oidc.jwksUri),
      rolesClaim: 'rolesClaim' in oidc ? oidc.rolesClaim : 'roles',
    });
    if (!result.ok) return denyApiOrRedirect(req, isAdminApi, 401);

    // ロール認可: Viewer は状態変更（書き込み）を行えない。
    // 管理 API だけでなく管理ページ（Server Action 等の POST）にも適用する。
    // 認証済みだが権限不足のため、ページ経由でも 401 リダイレクトではなく 403 を返す。
    if ((isAdminApi || isAdminPage) && isWriteMethod(req.method) && !canWrite(result.role)) {
      return NextResponse.json(
        { error: 'forbidden', message: 'insufficient role' },
        { status: 403 },
      );
    }
    return passThrough(req);
  }

  // --- 既存のパスワードセッション（provider=none。entra/cognito は上の SSO 分岐で処理済み） ---
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  const session = await verifySession(token, getAdminSecret());
  if (session?.role === 'admin') return passThrough(req);

  return denyApiOrRedirect(req, isAdminApi, 401);
}

export const config = {
  // origin-verify を全ルートで検証するため、静的アセット以外の全リクエストで実行する。
  // 認可（admin/api/admin）の適用は proxy() 内で pathname により分岐する。
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
