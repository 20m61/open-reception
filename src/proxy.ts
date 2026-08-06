import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildCsp, createCspNonce, NONCE_HEADER } from '@/lib/security/csp';
import { verifySession } from '@/lib/auth/session';
import { ADMIN_COOKIE, ENTRA_TOKEN_COOKIE, getAdminSecret } from '@/lib/auth/admin';
import { getAdminAuthConfig, validateAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { verifyOidcToken, createJwksResolver } from '@/lib/auth/entra';
import { canWrite } from '@/domain/auth/roles';
import {
  ORIGIN_VERIFY_HEADER,
  ORIGIN_VERIFY_LOG_MARKERS,
  evaluateOriginVerify,
  readOriginVerifyConfig,
  type OriginVerifyOutcome,
} from '@/lib/security/origin-verify';

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
 * CloudFront 経由アクセスの検証 (OAC POST 署名問題の回避方式。判定は origin-verify.ts)。
 * Function URL を authType=NONE で公開する代わり、CloudFront が origin custom header
 * `x-origin-verify` に高エントロピーのシークレットを付与する。これと一致しないリクエスト
 * （= Function URL 直叩き / CloudFront 迂回）は server function の全ルートで拒否する。
 *
 * **拒否の 2 種類を区別する (#612)。** どちらも「拒否」だが運用上は正反対で、混ぜると
 * 障害時に「攻撃されている」と「自分が壊れている」を切り分けられない。
 * - `mismatch`      … 直叩き（正常動作）。**または**ローテーションで CloudFront と Lambda が
 *                     ずれた状態（全断）。403 を返す
 * - `missing-secret`… 配備側の障害。全リクエストが落ちる。503 を返す
 */
let lastOriginVerifyReason: OriginVerifyOutcome['reason'] | 'initial' = 'initial';

/** テスト用にログ状態を初期化する（module scope なのでテスト順序に依存させない）。 */
export function __resetOriginVerifyLogState(): void {
  lastOriginVerifyReason = 'initial';
}

/**
 * **状態が変わったときだけ**ログする。
 *
 * 「プロセスにつき 1 回」のラッチは一方通行で、復旧してから再発したときに何も出ない。
 * `missing-secret` は matcher 除外パス（`/favicon.ico` 等）が `register()` を走らせると
 * 実際に復旧しうるので、これは机上の話ではない。出力量はラッチとほぼ変わらないまま、
 * 復旧と再発の両方が記録される。**値は一切出さない**（rules/pii-secret-minimization.md）。
 */
function logOriginVerifyTransition(reason: OriginVerifyOutcome['reason'], secret?: string): void {
  if (reason === lastOriginVerifyReason) return;
  lastOriginVerifyReason = reason;
  switch (reason) {
    case 'missing-secret':
      // 先頭は必ず共有マーカー。CDK のメトリクスフィルタがこの文字列を検索する (#630)。
      console.error(
        `${ORIGIN_VERIFY_LOG_MARKERS.missingSecret} but ORIGIN_VERIFY_SECRET is unresolved ` +
          '(unset, blank, or an unsubstituted {{resolve:...}}); rejecting every request.',
      );
      break;
    case 'mismatch':
      // 攻撃者が任意に発火できるので**毎リクエストは出さない**が、ゼロにもしない。
      // ローテーションで CloudFront と Lambda がずれると全リクエストがここへ落ちるため、
      // 「一部インスタンスに数行」＝スキャン、「全インスタンスに 1 行」＝配備破損、と切り分けられる。
      console.warn(
        `${ORIGIN_VERIFY_LOG_MARKERS.mismatch}; rejecting requests that bypass CloudFront.`,
      );
      break;
    case 'disabled':
      // シークレットが在るのに方式が表明されていない＝配備が降格された強い兆候。
      // 旧仕様ではこの組合せが「検証有効」を意味していた。
      if (secret) {
        console.warn(
          '[origin-verify] ORIGIN_VERIFY_SECRET is present but ORIGIN_VERIFY_REQUIRED is not set; ' +
            'origin verification is DISABLED.',
        );
      }
      break;
    case 'matched':
      break;
  }
}

function checkTrustedOrigin(req: NextRequest): NextResponse | null {
  const config = readOriginVerifyConfig(process.env);
  const outcome = evaluateOriginVerify(config, req.headers.get(ORIGIN_VERIFY_HEADER));
  logOriginVerifyTransition(outcome.reason, config.secret);
  if (outcome.ok) return null;
  return outcome.reason === 'missing-secret'
    ? denyOriginVerify('service unavailable', 503)
    : denyOriginVerify('forbidden', 403);
}

/**
 * origin-verify の拒否応答。`Content-Type` を明示する（ZAP 10019。`denyApiOrRedirect` の
 * リダイレクト応答と同じ理由で、この経路だけ欠落していた）。
 * 本文は理由を区別しない固定文言 ── `missing-secret` を外部に伝えると迂回可能な時間帯を教える。
 */
function denyOriginVerify(body: string, status: 403 | 503): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
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

/**
 * nonce ベース CSP（issue #200）。
 * Next.js はリクエストヘッダの Content-Security-Policy から nonce を抽出し、
 * SSR 時に自身の framework/inline script へ自動付与する。そのため pass-through
 * 応答ではリクエストヘッダにも CSP / x-nonce を載せる（レスポンスヘッダの付与は
 * proxy() の出口で全応答経路に対して一括で行う）。
 */
type CspContext = { nonce: string; value: string };

function passThrough(req: NextRequest, csp: CspContext): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(PATHNAME_HEADER, req.nextUrl.pathname);
  headers.set(NONCE_HEADER, csp.nonce);
  headers.set('content-security-policy', csp.value);
  return NextResponse.next({ request: { headers } });
}

/**
 * 同一オリジン iframe への埋め込みを許可するルート (#363)。
 * 受付体験スタジオ本体（/admin/demo）がプレビューを iframe で抱えるため、
 * プレビュールートのみ frame-ancestors 'self'（X-Frame-Options は next.config.ts 側で
 * SAMEORIGIN に上書き）。それ以外は従来どおり 'none' / DENY を維持する。
 */
const SELF_FRAMEABLE_PATHS = new Set<string>(['/admin/demo/preview']);

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const nonce = createCspNonce();
  const csp: CspContext = {
    nonce,
    value: buildCsp(nonce, {
      dev: process.env.NODE_ENV === 'development',
      frameAncestors: SELF_FRAMEABLE_PATHS.has(req.nextUrl.pathname) ? 'self' : 'none',
    }),
  };
  const res = await route(req, csp);
  // 全応答（pass-through / 拒否 / リダイレクト）に per-request CSP を付与する。
  res.headers.set('Content-Security-Policy', csp.value);
  return res;
}

async function route(req: NextRequest, csp: CspContext): Promise<NextResponse> {
  // CloudFront 迂回（Function URL 直叩き）を全ルートで拒否する（origin-verify 方式時のみ）。
  const originVerifyDenial = checkTrustedOrigin(req);
  if (originVerifyDenial) return originVerifyDenial;

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return passThrough(req, csp);

  const isAdminApi = pathname.startsWith('/api/admin');
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!isAdminApi && !isAdminPage) return passThrough(req, csp);

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
    if (!cfg.required) return passThrough(req, csp);

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
    return passThrough(req, csp);
  }

  // --- 既存のパスワードセッション（provider=none。entra/cognito は上の SSO 分岐で処理済み） ---
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  const session = await verifySession(token, getAdminSecret());
  if (session?.role === 'admin') return passThrough(req, csp);

  return denyApiOrRedirect(req, isAdminApi, 401);
}

export const config = {
  // origin-verify を全ルートで検証するため、静的アセット以外の全リクエストで実行する。
  // 認可（admin/api/admin）の適用は proxy() 内で pathname により分岐する。
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
