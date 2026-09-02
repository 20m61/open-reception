import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { __resetOriginVerifyLogState, proxy } from './proxy';
import { ORIGIN_VERIFY_LOG_MARKERS } from '@/lib/security/origin-verify';

/**
 * proxy の CSP 付与（issue #200）。
 * nonce ベース CSP がレスポンスごとに変わり、script-src に 'unsafe-inline' を
 * 含まないことを、代表的な応答経路（pass-through / 認証リダイレクト / API 拒否）で検証する。
 */

function req(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`);
}

function scriptSrcOf(csp: string): string {
  const directive = csp.split(';').find((d) => d.trim().startsWith('script-src'));
  expect(directive, `script-src missing in: ${csp}`).toBeTruthy();
  return directive!;
}

describe('proxy CSP (#200)', () => {
  it('公開ページ（kiosk）の pass-through 応答に nonce CSP を付与する', async () => {
    const res = await proxy(req('/kiosk'));
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    const scriptSrc = scriptSrcOf(csp!);
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('nonce はリクエストごとに異なる', async () => {
    const [a, b] = await Promise.all([proxy(req('/kiosk')), proxy(req('/kiosk'))]);
    const nonceOf = (res: Response) =>
      res.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it('Next.js が nonce を抽出できるよう、リクエストヘッダにも CSP を伝播する', async () => {
    const res = await proxy(req('/kiosk'));
    // NextResponse.next({ request }) の上書きヘッダは x-middleware-request-* に載る。
    const forwarded = res.headers.get('x-middleware-request-content-security-policy');
    expect(forwarded).toBeTruthy();
    expect(forwarded).toBe(res.headers.get('content-security-policy'));
    expect(res.headers.get('x-middleware-request-x-nonce')).toBeTruthy();
  });

  it('未認証 /admin のリダイレクト応答にも CSP を付与する（既存挙動 307 は維持）', async () => {
    const res = await proxy(req('/admin'));
    expect(res.status).toBe(307);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('未認証 /api/admin の 401 応答にも CSP を付与する（既存挙動 401 は維持）', async () => {
    const res = await proxy(req('/api/admin/receptions'));
    expect(res.status).toBe(401);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});

/**
 * CloudFront 経由検証 (#612)。判定そのものは origin-verify.test.ts が固定する。
 * ここで固定するのは proxy が **どの経路でその判定に従うか** と、
 * **拒否応答にシークレットが漏れないこと**。
 */
describe('proxy origin-verify (#612)', () => {
  const SECRET = 'TEST-origin-verify-secret';

  function reqWith(path: string, header?: string): NextRequest {
    return new NextRequest(`http://127.0.0.1:3000${path}`, {
      headers: header === undefined ? undefined : { 'x-origin-verify': header },
    });
  }

  beforeEach(() => {
    // ログ状態は module scope なので、テスト順序に依存させないため毎回初期化する。
    __resetOriginVerifyLogState();
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.ORIGIN_VERIFY_REQUIRED;
    vi.restoreAllMocks();
  });

  /** pass-through した証拠（403/503/401 のいずれでもなく、実際に素通りしている）。 */
  function expectPassedThrough(res: NextResponse): void {
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-x-or-pathname')).toBeTruthy();
  }

  it('シークレット未設定（ローカル / OAC 方式）では検証しない', async () => {
    expectPassedThrough(await proxy(reqWith('/kiosk')));
  });

  it('一致するヘッダを持つリクエストは通す', async () => {
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    expectPassedThrough(await proxy(reqWith('/kiosk', SECRET)));
  });

  // 検証は PUBLIC_PATHS の判定より **前** に走る。この順序が崩れると、認証エントリだけが
  // 迂回可能になったり、未信頼の呼び出し元に 401/200 を返して情報源になったりする。
  it.each(['/kiosk', '/admin', '/admin/login', '/api/admin/login', '/api/admin/receptions'])(
    'ヘッダ欠落（直叩き）は %s でも 403（公開ルート・認証エントリを含む）',
    async (pathname) => {
      process.env.ORIGIN_VERIFY_SECRET = SECRET;
      process.env.ORIGIN_VERIFY_REQUIRED = '1';
      const res = await proxy(reqWith(pathname));
      expect(res.status).toBe(403);
    },
  );

  it('方式を表明していなければ、シークレットが env に在っても検証しない', async () => {
    // appSecretsName の JSON に鍵を同居させ、context を渡し忘れた配備を想定。
    // CloudFront はヘッダを送らないので、ここで検証すると全ルートが 403 になる。
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    expectPassedThrough(await proxy(reqWith('/kiosk')));
  });

  it('origin-verify 方式なのにシークレットが未解決なら 503（403 ではない）', async () => {
    // 配備側の障害であってクライアントの問題ではないので、意味的にも監視上も 5xx が正しい。
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    const res = await proxy(reqWith('/kiosk', SECRET));
    expect(res.status).toBe(503);
  });

  it('直叩き（mismatch）と配備障害（missing-secret）を別ステータスで返す', async () => {
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    expect((await proxy(reqWith('/kiosk', 'wrong'))).status).toBe(403);

    delete process.env.ORIGIN_VERIFY_SECRET;
    expect((await proxy(reqWith('/kiosk', 'wrong'))).status).toBe(503);
  });

  it.each([
    ['mismatch', SECRET, 403],
    ['missing-secret', undefined, 503],
  ] as const)('%s の拒否応答にも Content-Type を付ける（ZAP 10019）', async (_l, secret, status) => {
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    if (secret) process.env.ORIGIN_VERIFY_SECRET = secret;
    const res = await proxy(reqWith('/kiosk', 'wrong'));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  // 🔴 ログが無いと、ローテーションで CloudFront と Lambda がずれた全断（全リクエスト mismatch）が
  // アプリログ 0 行・アラーム無し（#630）で進行し、直叩きスキャンと区別できない。
  it('mismatch を沈黙させない（ただし毎リクエストは出さない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    process.env.ORIGIN_VERIFY_REQUIRED = '1';

    for (let i = 0; i < 5; i++) await proxy(reqWith('/kiosk', 'wrong'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[origin-verify]');
  });

  // 🔴 CDK のメトリクスフィルタ (#630) はこのマーカーで検索する。ログ文言を書き換えると
  // **アラームが黙って鳴らなくなる**ので、実際の出力がマーカーで始まることを固定する。
  it('拒否ログは CDK と共有するマーカーで始まる (#630)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ORIGIN_VERIFY_REQUIRED = '1';

    await proxy(reqWith('/kiosk', SECRET)); // missing-secret
    expect(String(error.mock.calls[0]?.[0])).toContain(ORIGIN_VERIFY_LOG_MARKERS.missingSecret);

    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    await proxy(reqWith('/kiosk', 'wrong')); // mismatch
    expect(String(warn.mock.calls[0]?.[0])).toContain(ORIGIN_VERIFY_LOG_MARKERS.mismatch);
  });

  it('復旧してから再発したら再びログする（一方通行のラッチにしない）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ORIGIN_VERIFY_REQUIRED = '1';

    await proxy(reqWith('/kiosk', SECRET)); // missing-secret
    expect(error).toHaveBeenCalledTimes(1);

    process.env.ORIGIN_VERIFY_SECRET = SECRET; // 復旧（matcher 除外パスが register() を走らせた等）
    await proxy(reqWith('/kiosk', SECRET));

    delete process.env.ORIGIN_VERIFY_SECRET; // 再発
    await proxy(reqWith('/kiosk', SECRET));
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('シークレットが在るのに方式が表明されていなければ警告する（配備の降格）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ORIGIN_VERIFY_SECRET = SECRET;

    await proxy(reqWith('/kiosk'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('DISABLED');
  });

  it('ログにシークレットを含めない', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    await proxy(reqWith('/kiosk', 'wrong'));

    const logged = [...error.mock.calls, ...warn.mock.calls].flat().join(' ');
    expect(logged).not.toContain(SECRET);
  });

  it('拒否応答の本文・ヘッダにシークレットを一切含めない', async () => {
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
    const res = await proxy(reqWith('/kiosk', 'wrong'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
    for (const [, value] of res.headers) {
      expect(value).not.toContain(SECRET);
    }
  });

  /**
   * 既存の 2 本（`ログにシークレットを含めない` / `拒否応答の本文・ヘッダに…`）が塞いでいない
   * 隙間を埋める (#612 受入条件 3 つ目)。**既存は `mismatch` の 403 経路だけ**を、しかも
   * `console.error` と `console.warn` だけを見ている。埋めるのは次の 3 点:
   *
   * 1. **`disabled` 経路** — `logOriginVerifyTransition` が `secret` を実際に受け取って
   *    読むのはここだけなのに、未被覆だった（値を混ぜる変異を既存テストは 1 つも殺さない）
   * 2. **`console.log` / `info` / `debug`** — デバッグで足すならまずこの 3 つ。既存の spy を
   *    素通りする
   * 3. **`missing-secret` の 503 応答** — 既存は 403 しか見ていない
   *
   * 漏れると迂回できる: 値を知れば CloudFront を通さず直叩きできる
   * （`.claude/rules/pii-secret-minimization.md`）。
   */
  describe('シークレットの値を外へ出さない（既存被覆の隙間）', () => {
    /** 実 secret と紛れない目印。部分一致で偽陰性にならないよう十分に特異な値にする。 */
    const CANARY = 'TEST-canary-9f3a2b7c-origin-verify';

    /** console の**全レベル**を 1 本に集める。既存は error/warn しか見ていない。 */
    function captureConsole(): () => string {
      const chunks: string[] = [];
      const sink = (...args: unknown[]) => {
        chunks.push(args.map((a) => String(a)).join(' '));
      };
      for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation(sink);
      }
      return () => chunks.join('\n');
    }

    it.each([
      // secret が env に在る経路を網羅する。**`disabled` が主目的**（唯一 secret を読む分岐）。
      ['disabled', CANARY, CANARY, undefined],
      ['matched', CANARY, CANARY, '1'],
      ['mismatch', CANARY, 'wrong-header', '1'],
    ] as const)('%s でどのログレベルにも値が出ない', async (_label, envSecret, header, required) => {
      const readLog = captureConsole();
      process.env.ORIGIN_VERIFY_SECRET = envSecret;
      if (required !== undefined) process.env.ORIGIN_VERIFY_REQUIRED = required;

      await proxy(reqWith('/kiosk', header));

      expect(readLog()).not.toContain(CANARY);
    });

    it('missing-secret では未置換の CFN 参照（シークレット名）も出さない', async () => {
      // 既存は 403（mismatch）だけ。503 は配備障害の経路で env の状態が違う。
      // **未解決でも env には値が入っている** — `{{resolve:secretsmanager:<名前>:...}}` の
      // 生文字列で、シークレットの**保管場所の名前**を含む。これを吐くと攻撃者に
      // 「どこを狙えばよいか」を教える。デバッグで生 env を出す変異はここでしか捕まらない。
      const readLog = captureConsole();
      const UNRESOLVED =
        '{{resolve:secretsmanager:open-reception/TEST-canary-path:SecretString:ORIGIN_VERIFY_SECRET::}}';
      process.env.ORIGIN_VERIFY_REQUIRED = '1';
      process.env.ORIGIN_VERIFY_SECRET = UNRESOLVED;

      const res = await proxy(reqWith('/kiosk', CANARY));

      expect(res.status).toBe(503);
      const body = await res.text();
      expect(readLog()).not.toContain('TEST-canary-path');
      expect(body).not.toContain('TEST-canary-path');
      expect(body).not.toContain(CANARY);
      expect(JSON.stringify([...res.headers.entries()])).not.toContain(CANARY);
    });

    it('送られてきたヘッダの値を応答へ反射しない', async () => {
      // 攻撃者が任意に選べる値を echo すると、それ自体が反射の足場になる。
      captureConsole();
      process.env.ORIGIN_VERIFY_SECRET = CANARY;
      process.env.ORIGIN_VERIFY_REQUIRED = '1';
      const attacker = 'ATTACKER-SUPPLIED-abc123';

      const res = await proxy(reqWith('/kiosk', attacker));

      expect(await res.text()).not.toContain(attacker);
      expect(JSON.stringify([...res.headers.entries()])).not.toContain(attacker);
    });
  });
});

/**
 * 全断時の来訪者向け応答 (#629 / N2a)。
 *
 * 🔴 **危ないのは配線。** 判定と本文は `service-hold-page.test.ts` で縛ってあるが、
 * `denyOriginVerify` が呼ばなくなっても、あるいは Accept を見なくなっても、
 * そちらのテストは全部 green のままになる。
 */
describe('proxy origin-verify の来訪者向け応答 (#629)', () => {
  const SECRET = 'TEST-origin-verify-secret';

  function reqAccept(path: string, accept?: string): NextRequest {
    return new NextRequest(`http://127.0.0.1:3000${path}`, {
      headers: accept === undefined ? { 'x-origin-verify': 'wrong' } : { 'x-origin-verify': 'wrong', accept },
    });
  }

  beforeEach(() => {
    __resetOriginVerifyLogState();
    process.env.ORIGIN_VERIFY_SECRET = SECRET;
    process.env.ORIGIN_VERIFY_REQUIRED = '1';
  });

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.ORIGIN_VERIFY_REQUIRED;
  });

  it('🔴 ブラウザには読める画面を返す（英語 1 語で終わらせない）', async () => {
    const res = await proxy(reqAccept('/kiosk', 'text/html,application/xhtml+xml'));
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('スタッフ');
    expect(body).not.toBe('forbidden');
  });

  /**
   * 🔴 **API と webhook の応答を変えない。** ここが変わると、#629 が CloudFront 方式を
   * 避けた理由（Vonage の再送が HTML を受け取る）を middleware 側で再現してしまう。
   */
  it.each([
    ['application/json', 'API クライアント'],
    ['*/*', 'webhook / curl の既定'],
  ])('%s（%s）には従来どおり text/plain を返す', async (accept) => {
    const res = await proxy(reqAccept('/api/kiosk/health', accept));
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe('forbidden');
  });

  it('Accept ヘッダが無ければ従来どおり text/plain', async () => {
    const res = await proxy(reqAccept('/kiosk'));
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('🔴 503（全断）でも来訪者には同じ文面を出し、理由を漏らさない', async () => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    const res = await proxy(reqAccept('/kiosk', 'text/html'));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('スタッフ');
    // 403 と 503 で文面を変えない（迂回可能な時間帯を教えない）。
    expect(body.toLowerCase()).not.toContain('secret');
  });
});
