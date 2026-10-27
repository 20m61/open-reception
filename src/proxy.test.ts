import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, type NextResponse } from 'next/server';
import { __resetOriginVerifyLogState, config, proxy } from './proxy';
import { ORIGIN_VERIFY_LOG_MARKERS } from '@/lib/security/origin-verify';
import { buildCsp } from '@/lib/security/csp';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * proxy の CSP 付与（issue #200）。
 * nonce ベース CSP がレスポンスごとに変わり、script-src に 'unsafe-inline' を
 * 含まないことを、代表的な応答経路（pass-through / 認証リダイレクト / API 拒否）で検証する。
 */

function req(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`);
}

/**
 * 🔴 **完全名で引く（#1132 レビュー 8 周目）。** 前方一致だと CSP3 の
 * `script-src-elem`（`<script>` 要素について `script-src` を**上書きする**）を
 * 本体と取り違え、`find` が返す行が**並び順で変わる**。
 */
function scriptSrcOf(csp: string): string {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === 'script-src' || d.startsWith('script-src '));
  expect(directive, `script-src missing in: ${csp}`).toBeTruthy();
  return directive!;
}

/**
 * 🔴 **proxy が配る CSP を「全ルート」で固定する（#1132 レビュー 8→9 周目 / I4）。**
 *
 * `csp.test.ts` は `buildCsp` の**出力空間の全域**が絞られていることを縛る（I1/I2/I3）。
 * ここが縛るのは「proxy が配るのは**その空間の要素そのもの**である」——
 * すなわち proxy 側でヘッダへ追記したり、経路ごとに別の CSP を作ったりしていないこと。
 *
 * 🔴 **経路を数え上げるのをやめた（レビュー 9 周目 MAJOR 1）。** 8 周目は代表 8 経路の
 * リテラル表だったが、**表そのものに下界が無く**、8 行を 1 行へ縮める変異が生存した
 *（8 周目に `unboundedSources` の `.slice(0,1)` を直したのと厳密に同型の穴を、
 * それを直したその場で新しい機構に作り直していた）。さらに実測で、
 * **表に無い経路**（`/demo/`＝来訪者向け通話画面）へ追記する変異と、
 * `SELF_FRAMEABLE_PATHS` に `/kiosk/signage` を足す変異が**どちらも全緑**だった。
 *
 * **app router を走査して全ルートに当てる。** 数え上げをやめたので、
 * 新しい経路は**足した瞬間から検査対象**になる。
 */
const APP_DIR = join(process.cwd(), 'src', 'app');

/** app router のファイル配置から、proxy を通りうる pathname を導く。 */
function routePaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // ルートグループ `(x)` は URL に出ない。動的セグメントは固定値に置く。
        const seg = entry.name.startsWith('(')
          ? ''
          : entry.name.replace(/^\[\.{0,3}(.+)\]$/, 'probe-$1');
        walk(join(dir, entry.name), seg ? `${prefix}/${seg}` : prefix);
      } else if (entry.name === 'page.tsx' || entry.name === 'route.ts') {
        out.push(prefix === '' ? '/' : prefix);
      }
    }
  };
  walk(APP_DIR, '');
  return [...new Set(out)].sort();
}

/**
 * 🔴 **iframe 埋め込みを許すルートは 1 つだけ（テスト側のリテラル）。**
 * `proxy.ts` の `SELF_FRAMEABLE_PATHS` を import せずリテラルで持つ ——
 * 同じ供給源に依存すると、そこへ来訪者画面を足す変異が同語反復で通ってしまう
 *（実測: 8 周目の表では `/kiosk/signage` の追加が全緑だった）。
 */
const FRAMEABLE_PATHS = ['/admin/demo/preview'];

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

  // 🔴 `dev` はリテラルで持つ（proxy の述語を再計算しない）。vitest は NODE_ENV=test なので
  //    dev 側の緩和は乗らないはずで、乗ったらこの前提ごと赤くする。
  it('前提: unit は開発モードではない（下の固定が dev 緩和を見落とさないため）', () => {
    expect(process.env.NODE_ENV).not.toBe('development');
  });

  /**
   * 🔴 **個数のスラックをやめ、2 通りの導出の一致にする（レビュー 10 周目 MINOR 1）。**
   *
   * 元は `> 150`（実測 181）で、**31 経路ぶんの緩み**があった。実測: 走査に
   * `.filter((p) => !p.startsWith('/kiosk/'))` を入れて 177 に狭めつつ来訪者向け
   * サイネージを iframe 許可へ入れる変異が**全緑**だった —— 9 周目 MAJOR 1 が挙げた
   * 「`/kiosk/signage` の追加が全緑」と**同じ結末**で、機構を替えても下界の緩さが残っていた。
   *
   * `vonage-client.test.ts` の消費者走査と同じ形（**2 通りに数えて一致を縛る**）にする。
   */
  const routeFileCount = (): number => {
    let n = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name === 'page.tsx' || entry.name === 'route.ts') n += 1;
      }
    };
    walk(APP_DIR);
    return n;
  };

  /**
   * 🔴 **「行を選んで固定する」をやめ、関数の本体ごと固定する（レビュー 12 周目 MAJOR 1）。**
   *
   * 10 周目は「CSP 組み立ての 1 行」、11 周目は
   * 「`csp.value` / `buildCsp` / `cspOptionsFor` に当たる行の全体」を固定した。
   * どちらも**どのトークンを見るかを決める正規表現**を持つので、そこに当たらない位置に
   * 書けば素通りする。実測（12 周目）で 3 形が**全緑**だった:
   *
   * - `res.headers.set(...)` の行を `if (!req.cookies.get('vonage_beta')) { … }` で**囲む**
   *   （行そのものは不変。trim すれば字下げも消える）
   * - `return relaxForVonage(req, res);` と**別モジュールの helper へ委譲**する
   * - helper 内で cookie / env の等値を条件に上書きする
   *
   * **正規表現も行選別も捨てる。** CSP を作って配る 2 つの関数の**本体を丸ごと**固定すれば、
   * 「どこに書いたか」に依存しない —— 囲もうが委譲しようが**本体の編集**なので必ず赤い。
   * コメントと字下げは落とすので、説明を足すだけでは赤くならない。
   */
  const normalizedBody = (src: string, signature: string): string => {
    const from = src.indexOf(signature);
    expect(from, `${signature} が見つからない（走査が陳腐化した）`).toBeGreaterThan(-1);
    const to = src.indexOf('\n}\n', from);
    expect(to, `${signature} の終端が見つからない`).toBeGreaterThan(from);
    return src
      .slice(from, to)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
      .join('\n');
  };

  it('🔴 CSP を作って配る 2 つの関数の本体を固定する（囲む・委譲・追記を全部赤にする）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'proxy.ts'), 'utf8');
    expect(src).toContain('export async function proxy');

    expect(normalizedBody(src, 'export async function proxy(')).toBe(
      [
        'export async function proxy(req: NextRequest): Promise<NextResponse> {',
        'const nonce = createCspNonce();',
        'const csp: CspContext = Object.freeze({',
        'nonce,',
        'value: buildCsp(nonce, cspOptionsFor(req.nextUrl.pathname)),',
        '});',
        'const res = await route(req, csp);',
        "res.headers.set('Content-Security-Policy', csp.value);",
        'return res;',
      ].join('\n'),
    );

    expect(normalizedBody(src, 'function passThrough(')).toBe(
      [
        'function passThrough(req: NextRequest, csp: CspContext): NextResponse {',
        'const headers = new Headers(req.headers);',
        'headers.set(PATHNAME_HEADER, req.nextUrl.pathname);',
        'headers.set(NONCE_HEADER, csp.nonce);',
        "headers.set('content-security-policy', csp.value);",
        'return NextResponse.next({ request: { headers } });',
      ].join('\n'),
    );

    // 🔴 **ヘッダリテラルの数え上げは撤回した（レビュー 14 周目 MINOR 3 の実測で確認）。**
    //    固有の kill は「`proxy()` 内に 3 つ目の CSP 書き込みを足す」形だけだったが、
    //    それは**等価**である —— `proxy()` の最終行が**無条件で**上書きするので、
    //    この関数の中のどこに書いても配る値は変わらない（実測: respHasCdn=false）。
    //    🔴 **前提**: その等価性は「最終行が無条件 `set` である」ことに依存しており、
    //    それは上の本体の固定が守っている。増分 2 がこの最終行を条件付きにしたら族ごと生き返る。
    /**
     * 🔴 **`buildCsp` の出どころ（import）も固定する（レビュー 13 周目 MAJOR 1）。**
     * 本体の固定は `indexOf(signature)` 〜 `'\n}\n'` の内側しか見ないので、
     * **import 元を薄いラッパへ差し替える**と本体テキストは 1 文字も変わらない。
     * 実測: `csp-wire.ts`（モジュールスコープで env を読み CDN を足す）を作って
     * import を 1 語替える変異が **tsc 0 / unit 8862 本とも全緑**だった
     *（記録器もモジュール評価時の読みは拾えない —— 記録器を挿す前に読み終わっている）。
     */
    const cspImports = src
      .split('\n')
      .filter((line) => line.startsWith('import ') && /buildCsp|cspOptionsFor|createCspNonce/.test(line));
    expect(cspImports, 'CSP の関数はすべて @/lib/security/csp から取ること').toEqual([
      "import { buildCsp, cspOptionsFor, createCspNonce, NONCE_HEADER } from '@/lib/security/csp';",
    ]);
  });

  /**
   * 🔴 **CSP を「配るかどうか」の配線（matcher）を固定する（レビュー 12 周目 MAJOR 3）。**
   *
   * `config.matcher` を書き換えて通話画面や受付端末を除外すると、その経路は
   * **CSP も origin-verify も丸ごと効かなくなる**。実測: `staff/calls|kiosk` を除外する
   * 1 行の変異が **tsc 0 / unit 8860 本とも全緑**だった —— I4 は `proxy()` を直接呼ぶので
   * matcher を通らず、`routePaths()` も matcher と突き合わせていなかった。
   */
  // 🔴 **matcher のリテラル固定は撤回した（レビュー 14 周目 MINOR 3）。**
  //    下の「全経路が matcher に一致する」テストが除外 3 本の下界つきで包含している。

  it('🔴 I4 で当てている全経路が matcher に一致する（「全ルート」が本番の配線と揃っている）', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    const covered = [...routePaths(), ...EXTRA_PROBE_PATHS];
    expect(covered.length).toBeGreaterThan(150);
    for (const path of covered) {
      expect(pattern.test(path), `${path} は matcher に一致しない（proxy を通らない）`).toBe(true);
    }
    // 下界: 除外されるべきものが実際に除外されている（常に true を返す判定ではない）。
    for (const excluded of ['/_next/static/chunk.js', '/_next/image', '/favicon.ico']) {
      expect(pattern.test(excluded), `${excluded} が matcher に一致してしまう`).toBe(false);
    }
  });

  /**
   * 🔴 **env の面は「全ルート × リクエストの形」で記録し、毒値で対照する（レビュー 11→13 周目）。**
   *
   * env やリクエストヘッダを条件にした緩和は、**テストレーンでは env が未設定なので
   * 期待値と実測が揃って緩まない** —— 全ルート固定（I4）も e2e も構造的に反応しない。
   *
   * 10 周目は「proxy の CSP 組み立て 1 行」をテキストで固定して塞いだつもりだった。
   * **射程の主張が誤りだった**（レビュー 11 周目の実測）:
   *
   * - ピンが守るのは**その 1 文だけ**。`res.headers.set(...)` の**後で**上書きする形、
   *   `csp.value` を `route()` へ渡す前に書き換える形は、1 文字も触らずに全緑で通った
   * - ヘッダ書き込みの数え上げ `/'Content-Security-Policy'/g` は**大文字始まりだけ**を数えており、
   *   同じファイルの `passThrough` にある**小文字リテラルを最初から数え落としていた**
   *
   * **ピンごと撤回する。** 代わりに、`proxy()` 実行中に**実際に読まれた env キー**を記録し、
   * **その全部に毒値を入れて配る CSP が変わらないこと**を主張する。禁止も綴りも数え上げない。
   * `NODE_ENV` だけは除く（dev 緩和は正当な差なので、`csp.test.ts` の記録器が別に縛る）。
   */
  // 🔴 nonce は毎回変わるので正規化して比べる。**`g` を付ける** —— 将来 nonce が 2 箇所に
  //    載る正当な変更（`script-src-elem` の追加等）が入ったとき、片方だけ正規化して
  //    毎回赤くなるのを避ける（レビュー 12 周目 MINOR 4）。
  const cspSignature = (res: NextResponse): string =>
    res.headers.get('content-security-policy')!.replace(/'nonce-[^']+'/g, "'nonce-NORMALIZED'");

  /**
   * 🔴 **サンプルを「`/kiosk` 1 回」から「全ルート × 形」へ広げた（レビュー 13 周目 MAJOR 2）。**
   *
   * 11 周目の版は綴りに依存しなかったが、**入力のサンプルに依存していた** ——
   * 実測で `cspOptionsFor` に「`/staff/calls/` のときだけ env を読む」1 行を足す変異が
   * **unit 8862 本とも全緑**だった（`/kiosk` を通らないのでそのキーが一度も読まれない）。
   * `/kiosk` 1 回では 5 キーしか記録されないが、**全ルート × 形では 9 キー**読まれる。
   *
   * 1. **allowlist**: 読まれたキーの集合を固定する。どこで gate されていようと、
   *    **新しい env を読んだ時点**で赤い（述語の形に依存しない）
   * 2. **毒値**: 複数の値を入れても全ルートで CSP が変わらないこと。値を複数にするのは、
   *    `=== '1'` のような等値比較が 1 種類の毒値では反転しないため
   *    （11 周目にこれで N25 / N27 を取りこぼした）
   *
   * 🔴 1 は Next.js 内部のキーを含むので、版上げで**誤った赤**が出る。fail-closed 側の
   * ずれなので許容し、失敗メッセージでそう伝える。
   */
  const EXPECTED_ENV_READS = [
    'ADMIN_AUTH_PROVIDER',
    'ADMIN_AUTH_REQUIRED',
    'ADMIN_SESSION_SECRET',
    'AWS_LAMBDA_FUNCTION_NAME',
    'NEXT_RUNTIME',
    'NODE_ENV',
    'ORIGIN_VERIFY_REQUIRED',
    'ORIGIN_VERIFY_SECRET',
    '__NEXT_NO_MIDDLEWARE_URL_NORMALIZE',
  ];

  const nonceOf = (res: NextResponse): string | undefined =>
    res.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1];

  const POISON_VALUES = ['1', 'true', '0', '', "https://poison.example.invalid * 'unsafe-inline'"];

  const REQUEST_SHAPES: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['cookie 有り', { cookie: 'kiosk_session=probe; or_admin=probe' }],
    ['accept: text/html', { accept: 'text/html' }],
    ['x-forwarded-for 有り', { 'x-forwarded-for': '203.0.113.1' }],
    ['user-agent 有り', { 'user-agent': 'probe/1.0' }],
  ];

  it('🔴 CSP 経路が読む環境変数は固定の集合だけ（全ルート × 形で記録する）', async () => {
    const real = process.env;
    const reads = new Set<string>();
    const recorder = new Proxy(real, {
      get(target, key) {
        reads.add(String(key));
        return Reflect.get(target, key);
      },
      has(target, key) {
        reads.add(String(key));
        return Reflect.has(target, key);
      },
    });
    try {
      (process as { env: NodeJS.ProcessEnv }).env = recorder;
      for (const path of allProbedPaths()) await proxy(req(path));
      for (const [, headers] of REQUEST_SHAPES) {
        await proxy(new NextRequest('http://127.0.0.1:3000/kiosk', { headers }));
      }
    } finally {
      (process as { env: NodeJS.ProcessEnv }).env = real;
    }
    const keys = [...reads].sort();
    // 下界: 記録器が実際に動いている。
    expect(keys).toContain('NODE_ENV');
    expect(
      keys,
      '読む環境変数が変わった。CSP を env で緩めていないか確認すること' +
        '（Next.js の版上げで内部キーが増えた場合は、確認のうえ期待値を更新する）',
    ).toEqual(EXPECTED_ENV_READS);
  });

  it('🔴 配る CSP は NODE_ENV 以外の環境変数で変わらない（全ルートで毒値の負の対照）', async () => {
    const paths = allProbedPaths();
    const real = process.env;
    const baseline = new Map<string, string>();
    for (const path of paths) baseline.set(path, cspSignature(await proxy(req(path))));

    const poisonable = EXPECTED_ENV_READS.filter((key) => key !== 'NODE_ENV');
    expect(poisonable.length).toBeGreaterThan(0);
    for (const key of poisonable) {
      const previous = real[key];
      try {
        for (const value of POISON_VALUES) {
          real[key] = value;
          for (const path of paths) {
            expect(cspSignature(await proxy(req(path))), `${key}=${value} が ${path} の CSP を動かした`).toBe(
              baseline.get(path),
            );
          }
          // 🔴 **nonce の面は `cspSignature` が正規化して消している（レビュー 13 周目 MINOR 2）。**
          //    「env で nonce を固定する」変更は上のループでは原理的に見えないので、
          //    毒値を入れたまま per-request であることを別に主張する。
          const [first, second] = await Promise.all([proxy(req('/kiosk')), proxy(req('/kiosk'))]);
          expect(nonceOf(second), `${key}=${value} で nonce が固定された`).not.toBe(nonceOf(first));
        }
      } finally {
        if (previous === undefined) delete real[key];
        else real[key] = previous;
      }
    }
  });

  it('🔴 走査は route ファイルを 1 つも取りこぼしていない（2 通りの導出の一致）', () => {
    // ルートグループ `(x)` と動的セグメントがあると path は重複しうるが、今日は 0 件。
    expect(
      routePaths().length,
      '走査の前提が崩れた。ルートグループや動的セグメントで pathname が重複している —— ' +
        'このテストを消すのではなく routePaths() の導出を見直すこと',
    ).toBe(routeFileCount());
    expect(routeFileCount()).toBeGreaterThan(150);
  });

  /**
   * 🔴 **走査は `page.tsx` / `route.ts` しか拾わない（レビュー 10 周目 MINOR 3）。**
   * proxy の matcher が除外するのは `_next/static` / `_next/image` / `favicon.ico` だけなので、
   * **メタデータルート**（`manifest.webmanifest` / `icon` 等）・`public/` の静的配信・
   * **404**（`not-found.tsx` は Next の script 込みで描画される）も proxy を通る。
   * 走査で導けない面なのでリテラルで足す。
   */
  const EXTRA_PROBE_PATHS = [
    '/manifest.webmanifest',
    '/icon',
    '/apple-icon',
    '/assets/probe.png',
    '/avatar/probe.vrm',
    '/no-such-route-probe',
    '/kiosk/no-such-child-probe',
  ];

  /**
   * 🔴 **probe 表の下界（レビュー 11 周目 MINOR 1）。** 空にしても誰も気づかなかった。
   * 個数ではなく**目的**を主張する —— 各 probe は「走査では導けない面」を補うものなので、
   * `routePaths()` に含まれないことがその証拠になる。
   */
  const allProbedPaths = (): string[] => [...routePaths(), ...EXTRA_PROBE_PATHS];

  /**
   * 🔴 **中身も load-bearing にする（レビュー 13 周目 MINOR 3）。** 以前の下界は
   * 「本数 7」と「`routePaths()` から導けない」だけだったので、**7 本を全部 `/zz1`〜`/zz7`
   * へ置き換えても全緑**だった（実測）—— doc は「メタデータルートは probe へ足せ」と
   * 指示しているのに、その面を実際に代表しているかは誰も見ていなかった。
   */
  it('🔴 probe は走査で導けない経路を補っている（機構の下界）', () => {
    // メタデータルートの probe は、対応するファイルが実在することを根拠にする。
    const appFiles = readdirSync(APP_DIR).map((name) => name);
    expect(appFiles, 'manifest.ts が無いなら /manifest.webmanifest の probe は無意味').toContain('manifest.ts');
    expect(EXTRA_PROBE_PATHS).toContain('/manifest.webmanifest');
    // 静的配信と 404 の面も、それぞれ 1 本以上持っている。
    expect(EXTRA_PROBE_PATHS.some((probe) => probe.startsWith('/assets/'))).toBe(true);
    expect(EXTRA_PROBE_PATHS.some((probe) => probe.includes('no-such'))).toBe(true);

    const paths = new Set(routePaths());
    // 🔴 **本数もリテラルで固定する（レビュー 12 周目 MINOR 2）。** 「空でない」だけだと
    //    7 件を 1 件へ縮める変異が生存する（8 周目の `.slice(0,1)` と同じ「表を縮める」族）。
    expect(EXTRA_PROBE_PATHS).toHaveLength(7);
    for (const probe of EXTRA_PROBE_PATHS) {
      expect(paths.has(probe), `${probe} は走査で導ける（probe の意味が無い）`).toBe(false);
    }
  });

  it('🔴 iframe 許可の経路は走査に含まれている（走査から隠して許可する形を塞ぐ）', () => {
    const paths = routePaths();
    for (const p of FRAMEABLE_PATHS) {
      expect(paths, `${p} が走査から漏れている（隠したまま frame 許可できてしまう）`).toContain(p);
    }
    // 代表的な面が実際に含まれていること（空でも全部でもない、の具体化）。
    for (const p of ['/', '/kiosk', '/demo/probe-token', '/staff/calls/probe-id']) {
      expect(paths, `${p} が走査から漏れている`).toContain(p);
    }
  });


  it('🔴 全ルートが配る CSP は buildCsp の出力そのものである（追記も経路別の作り分けも無い / I4）', async () => {
    for (const path of [...routePaths(), ...EXTRA_PROBE_PATHS]) {
      const emitted = (await proxy(req(path))).headers.get('content-security-policy');
      expect(emitted, `CSP missing for ${path}`).toBeTruthy();
      const nonce = emitted!.match(/'nonce-([^']+)'/)?.[1];
      expect(nonce, `nonce missing for ${path}`).toBeTruthy();
      expect(emitted, path).toBe(
        buildCsp(nonce!, {
          dev: false,
          frameAncestors: FRAMEABLE_PATHS.includes(path) ? 'self' : 'none',
        }),
      );
    }
  });

  /**
   * 🔴 **pathname 以外の入力でも緩められないこと（レビュー 9 周目 MAJOR 1）。**
   * `req()` は cookie もヘッダも持たない `NextRequest` しか作らないので、
   * **cookie 条件で CSP を緩める変異が全緑だった**（実測）。リクエストの形を変えて当てる。
   */
  it.each(REQUEST_SHAPES)('🔴 リクエストの形（%s）で CSP が変わらない', async (_label, headers) => {
    const res = await proxy(new NextRequest('http://127.0.0.1:3000/kiosk', { headers }));
    const emitted = res.headers.get('content-security-policy');
    const nonce = emitted?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(emitted).toBe(buildCsp(nonce!, { dev: false, frameAncestors: 'none' }));
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
