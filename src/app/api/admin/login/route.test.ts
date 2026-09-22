/**
 * 管理ログイン route の**配線**テスト (#1021 AC1)。
 *
 * ## なぜ純関数のテストでは足りないか
 *
 * `getAdminPassword()` 側は `src/lib/auth/admin.test.ts` が縛っているが、それは
 * 「関数がどう解決するか」しか見ていない。**route がその関数を使い続けること**は
 * 別の面である —— 変異検証で `body.password !== getAdminPassword()` を
 * `body.password !== 'open-reception'` へ書き換えたところ、**リポジトリ全体の unit が
 * 素通りした**（2026-09-16 実測）。#826 と同型（純関数の分岐を全部 kill しながら、
 * 配線を戻す変異が全部素通りする）。
 *
 * ここで縛るのは実装の呼び出し形ではなく、**外から見える不変条件**である:
 *
 * > 公開リポジトリに載っている既定値 `open-reception` は、`ADMIN_PASSWORD` を設定した
 * > デプロイでは**通らない**。通るのは設定した値だけである。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE } from '@/lib/auth/admin';

/**
 * cognito の枝を「COGNITO_* が揃った実デプロイ」まで踏むために SRP だけ差し替える。
 * ここで見たいのは Cognito の認証結果ではなく、**その枝が `ADMIN_PASSWORD` に
 * 依存しないこと**なので、失敗で固定してよい。
 */
const cognitoSrpLogin = vi.fn(async (..._args: unknown[]) => ({ ok: false, reason: 'invalid' }) as const);
// 🔴 引数を捨てない。`() => cognitoSrpLogin()` にすると username/password の受け渡しを
// 変える変異に無力になる。
const reserveAttempt = vi.fn();
const recordSuccess = vi.fn();
vi.mock('@/lib/security/attempt-store', () => ({
  reserveAttempt: (...a: unknown[]) => reserveAttempt(...a),
  recordSuccess: (...a: unknown[]) => recordSuccess(...a),
}));
vi.mock('@/lib/auth/cognito-srp', () => ({
  cognitoSrpLogin: (...args: unknown[]) => cognitoSrpLogin(...args),
}));

import { POST } from './route';
import { __resetSecretUnavailableLog } from '@/lib/auth/secret-unavailable';

/** 公開リポジトリに平文で載っている dev フォールバック。 */
const PUBLIC_DEFAULT = 'open-reception';
const CONFIGURED = 'TEST-configured-admin-password';

/**
 * 🔴 **env は `vi.stubEnv` で立て、`vi.unstubAllEnvs` で戻す。**
 * `delete process.env.X` は `vitest.config.ts` の hermetic 固定（空文字）を**キーごと
 * 消す**ので、`--no-isolate` で隣のテストを落とす時限装置になる（#1021 / #1103）。
 * 自前の save/restore も同じことができるが、**規約を 2 通りにしない** ―― 同じ増分の
 * `admin.test.ts` / `answer-token.test.ts` は `vi.stubEnv` を使っている。
 */
beforeEach(() => {
  vi.stubEnv('ADMIN_AUTH_PROVIDER', undefined); // 既定 provider=none
  // 🔴 呼び出し回数をリセットする。しないと `toHaveBeenCalled()` が**ファイル内の
  // 実行順に依存**する（今は先行テストが SRP へ到達しないので偶然成立しているだけ）。
  cognitoSrpLogin.mockClear();
  reserveAttempt.mockReset();
    recordSuccess.mockReset();
  reserveAttempt.mockResolvedValue({
    allowed: true,
    nextWindow: { startedAt: 0, failures: 0 },
    onSuccess: { startedAt: 0, failures: 0 },
    onFailure: { startedAt: 0, failures: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const login = (password: unknown): Promise<Response> =>
  POST(
    new Request('https://example.test/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  );

const adminCookie = (res: Response): string | undefined =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${ADMIN_COOKIE}=`))
    ?.split('=')[1]
    ?.split(';')[0];

describe('POST /api/admin/login の鍵の配線 (#1021 AC1)', () => {
  describe('秘密を設定したデプロイ', () => {
    beforeEach(() => {
      vi.stubEnv('ADMIN_PASSWORD', CONFIGURED);
      // 🔴 **セッション鍵も設定する。** これを空のままにすると「設定したデプロイ」と
      // 名乗りながら**半分壊れたデプロイを happy path にしている**ことになる
      // （#1124 が `getAdminSecret()` を failClosed にした瞬間、無関係に赤くなる）。
      vi.stubEnv('ADMIN_SESSION_SECRET', 'TEST-admin-session-secret');
      vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'open-reception-server');
    });

    /** 🔴 **本体。** 公開されている既定値でログインできてはいけない。 */
    it('🔴 公開既定値 open-reception では 401 になり、セッションが出ない', async () => {
      const res = await login(PUBLIC_DEFAULT);
      expect(res.status).toBe(401);
      expect(adminCookie(res)).toBeUndefined();
    });

    /**
     * 🔴 **下界。** 「通らない」だけを主張すると、**何を出しても通らない**世界でも
     * 満たせる（`docs` の「下界を併せて縛る」）。設定した値では実際に通ることまで見る。
     */
    it('🔴 設定した値では 200 になり、セッション cookie が出る', async () => {
      const res = await login(CONFIGURED);
      expect(res.status).toBe(200);
      expect(adminCookie(res)).toBeTruthy();
    });
  });

  /**
   * 🔴 `ADMIN_PASSWORD` を入れ忘れたデプロイは **fail-closed**。
   * 以前はここで公開既定値 `open-reception` が通り、`tenant_admin` が取れた。
   *
   * 🔴 **「いまは誰も入れない」とは書けない（#1124）。** 閉じたのは**この扉**だけである。
   * 同じデプロイでは `ADMIN_SESSION_SECRET` も未設定なのが普通で、`getAdminSecret()` は
   * warn-only なので、**公開既定値で署名した cookie が管理セッションとして通る**
   * （実測）。ログイン API を塞いでも、隣の窓は開いたままになっている。
   *
   * 縛るのは「throw すること」ではなく**運用者が受け取る応答**である。throw を素通しに
   * すると status は Next の既定に委ねられ、テストで固定できない。
   */
  describe('デプロイで ADMIN_PASSWORD 未設定', () => {
    beforeEach(() => {
      vi.stubEnv('ADMIN_PASSWORD', undefined);
      vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'open-reception-server');
    });

    it('🔴 公開既定値でも入れない（500・セッションなし）', async () => {
      const res = await login(PUBLIC_DEFAULT);
      expect(res.status).toBe(500);
      expect(adminCookie(res)).toBeUndefined();
    });

    /**
     * 🔴 **未認証エンドポイントのログ出力量を攻撃者に握らせない。**
     *
     * `/api/admin/login` は誰でも叩けるので、1 リクエスト = 1 `console.error` にすると
     * **CloudWatch の費用が攻撃者の手に渡る**。`src/proxy.ts` は同じ理由で同じ形を採り、
     * その判断を明文化している (#630)。ここを縛らないと `console.error` を消す変異も
     * 毎回出す変異も**どちらも素通りする**（レビュー 5 周目が「検知の面にオラクルが
     * 1 本も無い」と指摘した族）。
     */
    it('🔴 設定不備は 1 度だけ記録し、リクエストごとには出さない', async () => {
      __resetSecretUnavailableLog();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (let i = 0; i < 3; i += 1) await login(PUBLIC_DEFAULT);
        // 下界: ゼロではない（消す変異を殺す）。上界: 回数に比例しない。
        expect(spy).toHaveBeenCalledTimes(1);
        // 🔴 値は出さない（rules/pii-secret-minimization.md）。出すのは env 名だけ。
        const logged = String(spy.mock.calls[0]?.[0] ?? '');
        expect(logged).toContain('ADMIN_PASSWORD');
        expect(logged).not.toContain(PUBLIC_DEFAULT);
      } finally {
        spy.mockRestore();
      }
    });

    it('🔴 本文に内部の設定状態を出さない（公開エンドポイント）', async () => {
      const body = await (await login(PUBLIC_DEFAULT)).json();
      expect(body).toEqual({ error: 'server_error' });
      expect(JSON.stringify(body)).not.toMatch(/ADMIN_PASSWORD|dev|fallback/i);
    });

    /**
     * 🔴 **応答が body の形で割れない。** 鍵の解決を body の型検査より**後**に置くと、
     * `{"password":123}` は 401・`{"password":"x"}` は 500 となり、**その差から
     * 「この環境は ADMIN_PASSWORD を持っていない」が未認証で読める**。
     *
     * 🔴 縛れているのは**未設定デプロイの内側で応答が揃うこと**だけである。
     * 設定済みデプロイの 401 との差は依然として外から読める（500 が返る＝
     * 誰も入れない状態なので実害は小さいが、**塞いだとは書かない**）。
     */
    it.each([PUBLIC_DEFAULT, 123, null, undefined])(
      'password が %p でも 500 に揃う（body の形で応答が割れない）',
      async (password) => {
        expect((await login(password)).status).toBe(500);
      },
    );
  });

  /** ローカル（非 Lambda）は従来どおり既定値で動く —— 開発と e2e を壊さない。 */
  it('ローカルでは既定値でログインできる（開発と e2e を壊さない）', async () => {
    vi.stubEnv('ADMIN_PASSWORD', undefined);
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', undefined);
    const res = await login(PUBLIC_DEFAULT);
    expect(res.status).toBe(200);
    expect(adminCookie(res)).toBeTruthy();
  });
});

/**
 * 🔴 **failClosed の爆発半径 (#1021)。**
 *
 * 上の describe が縛るのは「route が `getAdminPassword()` を**使う**こと」（上界）だが、
 * それだけでは足りない。縛るべきもう半分は「**他の provider の枝では呼ばないこと**」――
 * つまり `ADMIN_PASSWORD` の fail-closed が `provider=none` の外へ漏れないことである。
 *
 * 実測（2026-09-16）: `const configuredPassword = getAdminPassword();` を provider 分岐の
 * **手前へ 1 行巻き上げる**変異を当てたところ、**リポジトリ全体の unit 8661 本が素通りした**。
 * その世界では `ADMIN_AUTH_PROVIDER=cognito|entra` の実デプロイ（`ADMIN_PASSWORD` を持つ
 * 必要が無い構成）で**ログイン API が全部 500 = 管理コンソールへ誰も入れない**。
 * commit・doc・`.env.example`・`docs/deploy-aws.md` の 4 箇所が揃って
 * 「Cognito / Entra は壊れない」と主張しているのに、**何も鳴らなかった**。
 *
 * 不変条件: **他 provider の応答は `ADMIN_PASSWORD` の有無に依存しない。**
 */
describe('failClosed の爆発半径 — provider=none の外へ漏れない (#1021)', () => {
  beforeEach(() => {
    // 「実デプロイで ADMIN_PASSWORD 未設定」= まさに throw する条件を作る。
    vi.stubEnv('ADMIN_PASSWORD', undefined);
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'open-reception-server');
  });

  it('🔴 entra: ADMIN_PASSWORD が無くても throw せず 409 を返す', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', 'entra');
    const res = await login('anything');
    expect(res.status).toBe(409);
  });

  /**
   * 🔴 **未認証で叩けるので、ここのログもラッチする (#1123)。**
   * `/api/admin/login` は誰でも叩ける。設定不備を毎リクエスト記録すると
   * **CloudWatch の出力量が攻撃者の手に渡る**（ADMIN_PASSWORD 側と同じ理由）。
   */
  it('🔴 cognito（COGNITO_* 不完全）: 設定不備を 1 度だけ記録する', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', 'cognito');
    for (const k of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_REGION']) {
      vi.stubEnv(k, undefined);
    }
    __resetSecretUnavailableLog();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i += 1) await login('anything');
      expect(spy).toHaveBeenCalledTimes(1);
      const logged = String(spy.mock.calls[0]?.[0]);
      expect(logged).toContain('COGNITO_');
      // 🔴 **直した文面そのものを見る。** 欠けているのは 3 つの**いずれか**なので、
      // 「is not set」（＝全部未設定と読める）に戻す変異を殺す。
      expect(logged).toContain('incomplete');
      expect(logged).not.toMatch(/is not set/);
    } finally {
      spy.mockRestore();
      __resetSecretUnavailableLog();
    }
  });

  it('🔴 cognito（COGNITO_* 不完全）: ADMIN_PASSWORD が無くても 500 の JSON', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', 'cognito');
    for (const k of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_REGION']) {
      vi.stubEnv(k, undefined);
    }
    const res = await login('anything');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
  });

  /**
   * 🔴 **ここが本番の構成である。** 上の 2 本（entra・COGNITO_* 不完全）はどちらも
   * **パスワードの解決より手前で return する**枝なので、`getAdminPassword()` が
   * cognito の枝の**奥**へ入り込む変異には反応しない。commit・doc・`.env.example`・
   * `docs/deploy-aws.md` が揃って約束している「**COGNITO_\* が揃った実デプロイは壊れない**」
   * を縛るには、枝の奥まで踏む必要がある。
   */
  it('🔴 cognito（COGNITO_* 完備）: ADMIN_PASSWORD が無くても SRP の結果が返る', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', 'cognito');
    vi.stubEnv('COGNITO_USER_POOL_ID', 'ap-northeast-1_TESTPOOL');
    vi.stubEnv('COGNITO_CLIENT_ID', 'TEST-client-id');
    vi.stubEnv('COGNITO_REGION', 'ap-northeast-1');
    const res = await POST(
      new Request('https://example.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'someone', password: 'whatever' }),
      }),
    );
    // SRP は mock で失敗固定。見ているのは「401 が返ること」＝ 枝の奥まで到達し、
    // かつ `ADMIN_PASSWORD` 起因の 500 にすり替わっていないこと。
    expect(res.status).toBe(401);
    expect(cognitoSrpLogin).toHaveBeenCalledTimes(1);
    // 引数が素通しされていること（mock factory が引数を捨てる変異を殺す）。
    expect(cognitoSrpLogin.mock.calls[0]?.slice(0, 2)).toEqual(['someone', 'whatever']);
  });

  /**
   * 🔴 **下界。** 上の 3 本は「`ADMIN_PASSWORD` 起因で壊れない」しか言っていないので、
   * `getAdminPassword()` を**どこからも呼ばない**世界でも満たせる。
   * none の枝では確かに fail-closed になることまで見る。
   */
  it('🔴 none の枝では確かに fail-closed になる（500）', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', undefined);
    expect((await login(PUBLIC_DEFAULT)).status).toBe(500);
  });
});

/**
 * 試行回数制限 (#1021 AC4)。
 *
 * 🔴 **admin 側はロックアウトしてよい。** 来訪者導線ではなく、資格情報の価値は桁違いに
 * 高い（全テナントの設定・監査ログ・予約 PII に到達する）。ログインの頻度は 1 日数回なので、
 * 数分閉じても運用は壊れない —— kiosk 側と方針を変えている理由である。
 *
 * 🔴 **射程は `provider=none`（自前パスワード）だけ。** cognito 枝は Cognito 自身が
 * throttle を持ち（`login.reason === 'error'` → 503）、そこへ global な予算を重ねると
 * **外部認証の正当な利用者を巻き込む**。触らない。
 */
describe('試行回数制限 (#1021 AC4)', () => {
  it('🔴 予算超過なら 429 と Retry-After を返す', async () => {
    reserveAttempt.mockResolvedValue({ allowed: false, retryAfterMs: 90_000 });
    const res = await login(CONFIGURED);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
    expect(adminCookie(res)).toBeUndefined();
  });

  /**
   * 🔴 **予算超過なら**正しいパスワードでも**通さない**。
   * ここを「正しければ通す」にすると、総当たりの最後の 1 回だけ通るので予算が無意味になる。
   */
  it('🔴 予算超過なら正しいパスワードでも通さない', async () => {
    reserveAttempt.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await login(CONFIGURED);
    expect(res.status).toBe(429);
    expect(adminCookie(res)).toBeUndefined();
  });

  /** 🔴 下界: 予算内なら従来どおり通る（全部 429 にして満たしていない）。 */
  it('🔴 予算内なら正しいパスワードで通る（下界）', async () => {
    vi.stubEnv('ADMIN_PASSWORD', CONFIGURED);
    const res = await login(CONFIGURED);
    expect(res.status).toBe(200);
    expect(adminCookie(res)).toBeDefined();
  });

  it('🔴 パスワード不一致は失敗として数える', async () => {
    vi.stubEnv('ADMIN_PASSWORD', CONFIGURED);
    const res = await login('wrong');
    expect(res.status).toBe(401);
    // 🔴 予約の時点で数えているので、ここで数え直さない（二重計上になる）。
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it('🔴 成功したら失敗数をリセットする', async () => {
    vi.stubEnv('ADMIN_PASSWORD', CONFIGURED);
    await login(CONFIGURED);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  /** 🔴 429 の応答本文に入力値を出さない（未認証経路）。 */
  it('🔴 429 の応答本文に入力値を出さない', async () => {
    reserveAttempt.mockResolvedValue({ allowed: false, retryAfterMs: 1000 });
    const res = await login('TEST-secret-attempt');
    expect(await res.text()).not.toContain('TEST-secret-attempt');
  });

  /** 🔴 cognito 枝には予算を重ねない（外部認証の利用者を巻き込まない）。 */
  it('🔴 cognito provider では予算を見ない', async () => {
    vi.stubEnv('ADMIN_AUTH_PROVIDER', 'cognito');
    vi.stubEnv('COGNITO_USER_POOL_ID', 'pool');
    vi.stubEnv('COGNITO_CLIENT_ID', 'client');
    vi.stubEnv('COGNITO_REGION', 'ap-northeast-1');
    await POST(
      new Request('https://example.test/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'u', password: 'p' }),
      }),
    );
    expect(reserveAttempt).not.toHaveBeenCalled();
  });
});
