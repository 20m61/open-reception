import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { proxy } from './proxy';

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

  afterEach(() => {
    delete process.env.ORIGIN_VERIFY_SECRET;
    delete process.env.ORIGIN_VERIFY_REQUIRED;
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
});
