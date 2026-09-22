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
import { reportIncompleteConfig, reportSecretUnavailable } from '@/lib/auth/secret-unavailable';
import { ADMIN_LOGIN_POLICY } from '@/domain/security/attempt-budget';
import { recordSuccess, reserveAttempt } from '@/lib/security/attempt-store';

/**
 * 🔴 **試行予算の鍵はサイト全体（#1021 AC4）。** `x-forwarded-for` は詐称可能なので、
 * 発信元で鍵を切ると回されて素通りする。パスワードがサイト共通である以上、
 * 数える側もサイト共通にしかできない。
 *
 * 🔴 **admin 側はロックアウトしてよい。** 来訪者導線ではなく、資格情報の価値は桁違いに
 * 高い（全テナントの設定・監査ログ・予約 PII）。ログインの頻度は 1 日数回なので、
 * 数分閉じても運用は壊れない —— kiosk 側と方針を変えている理由である。
 */
const ATTEMPT_KEY = 'admin-login';

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
      // 🔴 ログはラッチへ寄せる (#1123)。ここも未認証で叩けるので、毎リクエスト出すと
      // **出力量を攻撃者が制御できる**（下の ADMIN_PASSWORD 側と同じ理由）。
      // 🔴 欠けているのは**いずれか**なので、「全部未設定」と読める文にしない。
      reportIncompleteConfig(
        'COGNITO_*',
        'cognito provider selected but COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID / COGNITO_REGION is incomplete',
      );
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
  //
  // 🔴 **鍵の解決は body を見る前に行う (#1021)。** 後にすると、設定漏れのデプロイで
  // `{"password":123}` は 401（型で弾かれ `getAdminPassword()` に到達しない）、
  // `{"password":"x"}` は 500 となり、**応答の差から「この環境は ADMIN_PASSWORD を
  // 持っていない」が未認証で読める**。先に解決すれば、body が何であれ 500 に揃う。
  // （設定済みデプロイの 401 との差は残る。500 = 誰も入れない状態なので実害は小さい。）
  //
  // 🔴 **throw を素通しにしない。** 公開エンドポイントなので内部の設定状態は本文に出さず、
  // 詳細はサーバログへ（上の cognito 枝と同じ方針）。素通しにすると Next の既定 500 になり、
  // 未認証で例外とスタックトレースを無制限に生ませられるうえ、運用者が受け取る応答が
  // テストで固定できない。
  let configuredPassword: string;
  try {
    configuredPassword = getAdminPassword();
  } catch {
    // ラッチ付きのログは `secret-unavailable.ts` に集約してある（機構を 2 つ持たない）。
    // 🔴 status は 500 のまま。ここを 503 に揃えるかは #1127 の判断で、この増分では触らない。
    reportSecretUnavailable('ADMIN_PASSWORD');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // 🔴 **予算は鍵の解決の【後】に見る（#1021 AC4）。**
  //
  //    最初は解決より前に置いたが、それだと**設定漏れのデプロイで攻撃面が変わる** ——
  //    予算の記録はデータバックエンドに置くので、`DATA_BACKEND` 未設定の壊れたデプロイでは
  //    `getBackend()` が throw し、`broken-deploy-reachability.test.ts` が固定している
  //    「公開既定値では入れず、セッションも出ない」が**未捕捉の 500** へ化けた（実測）。
  //
  //    後ろへ置いて失うものは無い: 鍵が無いデプロイは**どんなパスワードでも 500** なので
  //    総当たりする対象が無い。ここの比較は文字列比較（`!==`）で、kiosk 側の PBKDF2 と違い
  //    **計算増幅も無い**ので、照合前に断る必要もない。
  //
  //    射程は `provider=none` だけ —— cognito 枝は Cognito 自身が throttle を持ち、
  //    そこへ global な予算を重ねると外部認証の正当な利用者を巻き込む。
  // 🔴 **予約してから照合する（Codex レビュー P1）。** 読み取り専用の判定は
  //    並行バーストで素通りする（authorize 側と同じ穴）。
  const budget = await reserveAttempt(ATTEMPT_KEY, ADMIN_LOGIN_POLICY, Date.now());
  if (!budget.allowed) {
    // 値（入力されたパスワード）は応答に出さない。
    return NextResponse.json(
      { error: 'too_many_attempts', message: 'too many attempts; try again later' },
      { status: 429, headers: { 'retry-after': String(Math.ceil(budget.retryAfterMs / 1000)) } },
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string' || body.password !== configuredPassword) {
    // 予約の時点で数えてあるので、ここで数え直さない（二重計上になる）。
    return NextResponse.json({ error: 'unauthorized', message: 'invalid password' }, { status: 401 });
  }
  // 🔴 成功したら失敗数を捨てる（正しく入った直後に予算切れで断られる形を作らない）。
  await recordSuccess(ATTEMPT_KEY);
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
