import { describe, expect, it, vi } from 'vitest';
import { buildCsp, cspOptionsFor, createCspNonce } from './csp';

describe('createCspNonce', () => {
  it('呼び出しごとに異なる値を返す（per-request nonce）', () => {
    const seen = new Set(Array.from({ length: 20 }, () => createCspNonce()));
    expect(seen.size).toBe(20);
  });

  it('CSP ヘッダに安全に埋め込める base64 文字列を返す（十分なエントロピー長）', () => {
    const nonce = createCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // 128bit 以上のエントロピー（base64 で 22 文字以上）を要求する。
    expect(nonce.length).toBeGreaterThanOrEqual(22);
  });
});

describe('buildCsp', () => {
  const nonce = 'dGVzdC1ub25jZQ==';

  /**
   * 🔴 **ディレクティブは「完全名」で引く（レビュー 8 周目 MINOR 3）。**
   *
   * 元は `startsWith('script-src')` / `find(...)` だった。CSP3 の
   * `script-src-elem` / `style-src-elem` は**接頭辞が一致する別ディレクティブ**で、
   * しかも `<script>` / `<style>` 要素について `script-src` / `style-src` を**上書きする**。
   * 前方一致だと、足された `-elem` 行を**本体だと思って検査してしまう**か、
   * `find` が先に見つけた方を返すかで、**kill が配列の並び順で変わる**。
   * 並び順で結果が変わる guard は「止まった」を保証しない。
   */
  it('script-src を nonce 化し unsafe-inline を含めない (#200)', () => {
    const scriptSrc = directivesOf(buildCsp(nonce)).get('script-src')!;
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // 段階導入: strict-dynamic は付けない（'self' で同一オリジン chunk を許可）。
    expect(scriptSrc).not.toContain("'strict-dynamic'");
  });

  it("style-src から unsafe-inline を排除する（'self' のみ / #289）", () => {
    expect(directivesOf(buildCsp(nonce)).get('style-src')).toEqual(["'self'"]);
  });

  it("style-src-attr は 'unsafe-inline' を許可する（React SSR の style 属性 / #289）", () => {
    expect(directivesOf(buildCsp(nonce)).get('style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it('開発時のみ style-src に unsafe-inline を許可する（HMR の style 注入）', () => {
    const styleSrcOf = (csp: string) => directivesOf(csp).get('style-src')!;
    expect(styleSrcOf(buildCsp(nonce, { dev: true }))).toContain("'unsafe-inline'");
    expect(styleSrcOf(buildCsp(nonce, { dev: false }))).not.toContain("'unsafe-inline'");
  });

  /**
   * 🔴 **配る CSP を 1 文字ずつ固定する（#1132）。方式を裏返した。**
   *
   * 元は `not.toContain(' https:')`（ZAP 10055 = ワイルドカード禁止）だったが、
   * 部分文字列一致なので**具体ホストを 1 つ足しただけで落ちた**。そこで
   * 「ワイルドカードとは何か」を判定する述語を書いたが、**禁止の列挙は裾が長い** ——
   * レビューが「`https://*` に port や path が付いた形」「`*:*`」「`script-src data:`」を次々に見つけ、
   * 正規表現へ port と path を足していく形（#788 の「値を調整している」型）になった。
   *
   * **列挙をやめて allowlist へ裏返す。** 配る CSP そのものを期待値として持てば:
   *
   * - ワイルドカードの**族ごと**落ちる（期待値と一致しなくなる）。裾を数えなくてよい
   * - 判定する機構（と、その穴）が**消える**
   * - CSP を変えるときは必ずここが赤くなる＝**判断が diff に出る**。
   *   #1132 増分 2 が CSP を開いたら、そのときここを書き換えるのが正しい
   *
   * 🔴 **ここが持つのは「中身」だけ。** 実際に配られているか（配線）は
   * `tests/e2e/security-headers.spec.ts` が `buildCsp` と突き合わせて縛る。
   * 同じ期待文字列を 2 か所に書かない。
   */
  const EXPECTED_PROD_CSP = [
    "default-src 'self'",
    "script-src 'self' 'nonce-test-nonce'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "media-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  /**
   * 🔴 **固定だけでは ZAP 10055 の「性質としての主張」が消える（レビュー 3 周目の実測）。**
   *
   * 期待値を固定すると、**CSP を緩めて期待値も一緒に書き換える**変異 —— つまり増分 2 の
   * 担当者が実際にやる形 —— が unit 8790 本を素通りする。旧実装 `not.toContain(' https:')` は
   * これを殺していたので、**新方式のほうが優れていても退行**である
   * （`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら当て直す」）。
   * しかも ZAP 本体は `--full` に無く、稼働 URL 前提の手動レーンなので走っていない。
   *
   * 🔴 **禁止の列挙には戻らない。** 述語版は `https://*` に port や path が付いた形・`*:*`・
   * `script-src data:` と裾が伸び続けた。ここでは**許す形**を書く。
   *
   * 🔴 **ただし「裾が無い」とは書かない（レビュー 4 周目の指摘）。** 一度そう書いたが誤りで、
   * この検査が見ているのは **ZAP 10055 のうちワイルドカードの面だけ**である。
   *
   * 引用キーワード（`'unsafe-inline'` / `'strict-dynamic'` 等）は**素通りする**。
   * それらを値まで縛る個別テストが在るのは **`script-src` / `style-src` /
   * `style-src-attr` / `default-src` の 4 つだけ**で（名指しで書く。「個別テストの担当」
   * とだけ書くのは網羅の自己申告）、残り 8 ディレクティブは全文固定だけが守っている。
   *
   * 🔴 **`http://` も報告される。** 一度「10055 の射程外なので通す」と書いたが、
   * ホストの形で判定するのをやめた結果、**平文 http のホストも「絞られていない」側へ落ちる**
   * （レビュー 7 周目の実測。散文のほうが弱くずれていた）。
   *
   * 🔴 **スキームの例外は「そのディレクティブが実際に持っているもの」に限る。**
   * 最初は `data:` / `blob:` をディレクティブ横断で通していたため、
   * **`script-src data:` が素通りした**（レビュー 4 周目の実測）—— nonce CSP が
   * `<script src="data:text/javascript,…">` で**完全に迂回可能**になる形である。
   * 2 周目の述語版はこの族を殺していたので、方式を替えたときに落とした退行だった。
   */

  /**
   * 意図して許可しているスキームを、**そのスキームを実際に持つディレクティブ**に限って通す。
   *
   * 🔴 **`EXPECTED_PROD_CSP` から導出しない（レビュー 5 周目）。** 一度そうしたが、
   * **判定器が判定対象と同じ供給源に依存する＝自己承認**になっていた ——
   * `connect-src data:` / `default-src blob:` / `media-src blob:` の相関変異が素通りした。
   * すぐ上の doc で「共通モード故障を避ける」と書きながら、スキームの面ではそれを作っていた。
   *
   * 手で書けば、相関変異は**3 か所目のリテラル**を触らないと通らない。
   * Map の構築ロジックと `split` が消えるので**機構は純減**する。
   */
  const ALLOWED_SCHEME_BY_DIRECTIVE = new Map<string, Set<string>>([
    ['img-src', new Set(['data:', 'blob:'])],
    ['font-src', new Set(['data:'])],
    ['connect-src', new Set(['blob:'])],
    ['media-src', new Set(['data:'])],
  ]);

  /**
   * 絞られていない source を `<directive> <token>` の形で返す。
   *
   * 🔴 **ホストの allowlist は持たない（レビュー 7 周目で撤回）。** 一度
   * `ALLOWED_SOURCES`（空の Set）を置いたが、**枝ごと削除しても振る舞いはビット同一**
   * だった —— 6 周目に `hostOf` を撤回したときと**同一の測定結果**である。
   * 「守るものが無い機構は撤回する」を自分に適用した。
   * 増分 2 が実際に許可するホストを持った時点で導入すれば、そのとき初めて
   * 満たすべき不変条件が書ける。
   *
   * したがって**今日はホストらしき token が全部報告される** ——
   * 増分 2 は「CSP を緩める」だけでは緑にできず、**許可の機構を導入する判断**を
   * diff に出すことになる。
   */
  function unboundedSources(csp: string): string[] {
    const out: string[] = [];
    for (const directive of csp.split(';')) {
      const tokens = directive.trim().split(/\s+/);
      const name = tokens[0] ?? '';
      for (const token of tokens.slice(1)) {
        if (token.length === 0) continue;
        // 許す形 1: 引用キーワード（'self' / 'none' / 'nonce-…' / 'unsafe-…'）。
        // 🔴 中身は見ない —— 個別テストの担当（上の doc 参照）。
        if (/^'[^']*'$/.test(token)) continue;
        // 許す形 2: **このディレクティブが元から持っている**スキーム。
        if (ALLOWED_SCHEME_BY_DIRECTIVE.get(name)?.has(token)) continue;
        out.push(`${name} ${token}`);
      }
    }
    return out;
  }

  /**
   * 🔴 **期待値そのものにも当てる。** 上の固定と同じ供給源に依存すると、
   * 「CSP と期待値を一緒に書き換える」変異に対して**共通モード故障**になる。
   */
  /**
   * 🔴 **検査を「呼び出しの列挙」から「入力空間の全域」へ移す（レビュー 8 周目 BLOCKER 1）。**
   *
   * 元は `buildCsp(nonce)` / `{dev:true}` / `{frameAncestors:'self'}` の **3 つの呼び出し形**に
   * だけ当てていた。`buildCsp` の出力は `(nonce, opts)` の関数なので、**opts にキーが 1 つ
   * 増えると検査の外へ出る**。実測（レビュー 8 周目）: `call?: boolean` を足し、
   * `proxy.ts` で `call: pathname.startsWith('/kiosk')` と配線して来訪者受付端末へ
   * `script-src … https://* http://* *` を配る変異が、**期待値を 1 文字も書き換えずに**
   * unit 8824 本・e2e 29 本とも緑だった。#200 の nonce 保護が `/kiosk` で丸ごと無効になる。
   *
   * 満たすべき不変条件を先に書く:
   *
   * - **I1** `buildCsp` の出力は、**opts のどの組合せでも**絞られていない source を持たない
   * - **I2** ディレクティブ名の集合は、**どの組合せでも**固定である
   * - **I3** ここで列挙する組合せは、`csp.ts` が実際に受け取るキーの**全体**から作られている
   *
   * I3 が無いと I1/I2 の「どの組合せでも」が**自己申告**になる（＝元の穴そのもの）。
   * 網羅性は主張できないので、**キーの集合をソースから機械的に読んで突き合わせる** ——
   * `vonage-client.test.ts` の消費者走査と同じ形である。
   */
  /**
   * 🔴 **I3 は型で縛る。ソース走査は撤回した（レビュー 9 周目 BLOCKER 1）。**
   *
   * 8 周目は `csp.ts` を正規表現（`/^\s{4}(\w+)\?:/gm`）で走査していたが、
   * **`readonly vonage?: boolean` と書くとマッチせず、無言で取りこぼした** ——
   * しかも `readonly x?:` は `CLAUDE.md`（永続スキーマの互換追加）が**推奨している綴り**で、
   * `src/` に同型が 28 ファイルある。実測: その綴りで opts を足して `/demo/` へ配線すると、
   * **来訪者画面へワイルドカードホストを配りながら unit 8844 本が全部緑**だった。
   *
   * 正規表現に `(?:readonly\s+)?` を足すのは、綴りを 1 → 3 → 文法判定と作り替えた
   * #813 と同型の「値を調整している」型である。**機構ごと撤回して型検査へ裏返す。**
   * `Record<CspOptionKey, …>` は、キーが 1 つでも増えたら
   * `TS2741: Property 'vonage' is missing` で**タイプチェックが落ちる** ——
   * 綴り・インデント・`readonly`・改行位置に一切依存しない。
   * 走査・`readFileSync`・キーのリテラル列挙・その下界（レビュー 9 周目 m1）が**まとめて消える**。
   */
  type CspOptionKey = keyof NonNullable<Parameters<typeof buildCsp>[1]>;

  /**
   * 各キーが取りうる値。**`undefined`（未指定）を必ず含める** —— 既定値の側にも
   * 緩和を仕込めるため。**キーを増やすと型が落ちる**（I3）。
   */
  const OPTION_VALUES: Record<CspOptionKey, readonly unknown[]> = {
    dev: [undefined, true, false],
    frameAncestors: [undefined, 'none', 'self'],
  };

  const CSP_OPTION_KEYS = Object.keys(OPTION_VALUES) as CspOptionKey[];

  /**
   * 🔴 **型で縛った I3 の下界（レビュー 10 周目 MAJOR 2）。**
   *
   * `CspOptionKey` が `string` へ**退化**すると `Record<CspOptionKey, …>` は何でも受け、
   * I3 が無言で消える。実測: `opts` に索引シグネチャ（`[key: string]: unknown`）を足すという
   * **ありふれたリファクタ**で退化し、そのとき tsc が出すのは
   * 「テスト側の添字アクセスが undefined かも」という `TS2532` 2 件だけ ——
   * `!` を 2 つ足す**自然な直し方**をすると tsc 0 / 124 passed になり、
   * **テストを 1 行も消していないのに I3 が消える**。
   *
   * 「キーを 1 つ落とした `Record` は**型エラーになる**」を固定する。退化すると
   * エラーが出なくなり、`@ts-expect-error` 自体が `TS2578` で落ちる。
   *
   * 🔴 これは 9 周目に「走査を型へ裏返した」とき、**走査が持っていた下界だけを
   * 引き継がなかった**ために空いていた穴である（方式を替えたら当て直す、の裏側）。
   */
  // @ts-expect-error キーを 1 つ落とした Record は型エラーでなければならない（I3 が生きている証拠）
  const _optionKeysAreExhaustive: Record<CspOptionKey, readonly unknown[]> = { dev: [] };
  void _optionKeysAreExhaustive;

  /** opts の**直積**（＋ opts 自体を渡さない形）。今日は 1 + 3×3 = 10 通り。 */
  function allOptionCombos(): Array<Record<string, unknown> | undefined> {
    let combos: Array<Record<string, unknown>> = [{}];
    for (const key of CSP_OPTION_KEYS) {
      combos = combos.flatMap((base) => OPTION_VALUES[key].map((v) => ({ ...base, [key]: v })));
    }
    return [undefined, ...combos];
  }

  type CspOpts = Parameters<typeof buildCsp>[1];

  /**
   * 🔴 **直積そのものの下界（8 周目の変異 N10 が生存して分かった）。**
   *
   * I1/I2 は「列挙した全部で成り立つ」としか言っていないので、**列挙を 1 通りに縮める**
   * 変異（`return [undefined]`）が**無言で生存した** —— 全域性の主張が空虚になる形である。
   * MAJOR 1（走査ループに下界が無い）と同型の穴を、それを直したその場で作っていた。
   *
   * 個数は**リテラル**で持つ（`OPTION_VALUES` から計算すると、値を減らす変異に追随して
   * しまい同語反復になる）。オプションや値を増減したらここが赤くなる＝判断が diff に出る。
   */
  /**
   * 🔴 **I1〜I3 が縛るのは「引数の全域」であって「入力の全域」ではない（レビュー 9 周目 MAJOR 2）。**
   *
   * `csp.ts` がモジュールスコープで環境変数を読むと、テストプロセスでは未設定のまま
   * **本番だけが緩む**。実測: `process.env.VONAGE_CSP_SCRIPT_SRC` を `script-src` へ
   * 混ぜる変異が unit 126 本とも緑だった（e2e も同じ env を共有するので一致してしまう）。
   * `NEXT_PUBLIC_VONAGE_SDK_URL` という前例が既にあるので、増分 2 で自然に出る形である。
   *
   * 直積で全域を当てられるのは **`buildCsp` が引数だけの純関数だから**なので、
   * その前提そのものを機械にする。
   */
  /**
   * 🔴 **env の面は「ソースの綴り」ではなく「実行時に読まれたキー」で縛る（レビュー 11 周目 BLOCKER 1）。**
   *
   * 10 周目は `code.matchAll(/process\.env\.(\w+)/g)` で allowlist を作ったが、
   * **`process.env['X']` / `const { X } = process.env` を素通り**させた。実測: 角括弧綴りで
   * `script-src` に env を混ぜる変異が tsc 0 / 110 passed とも全緑（しかも角括弧は
   * `server-secret.ts` 等この repo の既存イディオム）。
   *
   * 🔴 **これは 9 周目に撤回した `readonly x?:` 走査と同じ族**である ——
   * 「知らない綴りを取りこぼす＝**fail-open**」。散文は「許可の列挙」と言っていたが、
   * 実体は「`process.env.` というトークンの出現を数え上げる」検出器だった。
   *
   * **方式を裏返す**: `process.env` を Proxy で包んで**実際に読まれたキーを記録**する。
   * 綴り・分割代入・動的アクセスのいずれでも `get` / `has` トラップが発火するので、
   * 「知らない書き方」という概念が消える。
   */
  async function envKeysReadBy(run: (mod: typeof import('./csp')) => void): Promise<string[]> {
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
    vi.resetModules();
    try {
      (process as { env: NodeJS.ProcessEnv }).env = recorder;
      // 🔴 モジュール評価より前に差し込む（モジュールスコープの読みも拾うため）。
      run(await import('./csp'));
    } finally {
      (process as { env: NodeJS.ProcessEnv }).env = real;
      vi.resetModules();
    }
    return [...reads].sort();
  }

  /**
   * 🔴 **`NODE_ENV` の「免除」が最後の抜け穴だった（レビュー 14 周目 MAJOR 1）。**
   *
   * 記録器も毒値も `NODE_ENV` を**除外**している（dev 緩和は正当な差なので）。
   * ところがその免除のせいで、**`NODE_ENV === 'production'` で条件付けた緩和**が
   * 9 機構すべてと unit 8863 本を素通りした（実測）——
   * 9〜11 周目が閉じようとした「**本番だけが緩む**」族が、その対策の免除条項から復活していた。
   * しかも `process.env.NODE_ENV === 'production'` は**この repo の既存イディオム**である。
   *
   * 検出器を足さず、**免除を撤回する**: `NODE_ENV` は除外するのではなく、
   * **どう依存してよいかを 1 文字ずつ書く**。
   *
   * - `buildCsp` は `NODE_ENV` に**一切依存しない**（dev は引数で決まる）
   * - `cspOptionsFor` の `NODE_ENV` 依存は **`dev` の 1 ビットだけ**
   */
  const withNodeEnv = <T,>(value: string | undefined, run: () => T): T => {
    const previous = process.env.NODE_ENV;
    try {
      if (value === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = value;
      return run();
    } finally {
      if (previous === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  };

  // 🔴 **列挙そのものの下界（実測 N65）。** `production` を落とすと、この面の主張が
  //    そのまま空虚になる（今日のコードは NODE_ENV に依存しないので、単独では差が出ない）。
  const NODE_ENV_VALUES = ['production', 'test', 'development', '', undefined];

  /**
   * 🔴 **モジュールスコープの読みまで届かせる（レビュー 15 周目 MAJOR 1）。**
   *
   * 14 周目の総当たりは `withNodeEnv` で**呼び出し時**の値だけを動かしていた。
   * `const PROD = process.env.NODE_ENV === 'production'` のように
   * **モジュールスコープ**で読むと、静的 import 済みのモジュールは `NODE_ENV=test` のときに
   * 一度だけ評価されているので、`withNodeEnv` が何をしても値は動かない ——
   * 総当たりは「出力が変わらない」と読んで**緑になる**。
   *
   * 実測（15 周目）: `cspOptionsFor` の `frameAncestors` を
   * `PROD && pathname.startsWith('/kiosk')` で緩める変異が **tsc 0 / unit 8864 本 / e2e 30 本とも全緑**で、
   * 実ビルドを `next start` して `curl` すると **`/kiosk` が `frame-ancestors 'self'` を返した**
   *（`frame-ancestors` があるとブラウザは `X-Frame-Options` を無視するので、
   * 来訪者受付端末が本番でだけ same-origin frameable になる）。
   *
   * **機構は足さない。** `envKeysReadBy` が既に使っている
   * `vi.resetModules()` + 動的 import を、この 2 本にも流用する ——
   * `NODE_ENV` ごとにモジュールを**評価し直し**、そのうえで**呼び出し時**の値も動かす。
   * これで関数スコープとモジュールスコープの両方を覆う。
   */
  /**
   * 🔴 **`await` を env の差し替えの**内側**に置く。** 最初この関数を
   * `withNodeEnv(value, () => import('./csp'))` と書いたが、`withNodeEnv` は同期なので
   * `finally` が **`import()` を開始した直後**に `NODE_ENV` を戻してしまい、
   * モジュールは**戻った後の値**で評価されていた —— 変異 N66 / N67 が生存して分かった
   *（レビューが提案した形をそのまま書いて踏んだ。**行列が拾った**）。
   */
  const loadUnderNodeEnv = async <T,>(value: string | undefined, load: () => Promise<T>): Promise<T> => {
    vi.resetModules();
    const previous = process.env.NODE_ENV;
    try {
      if (value === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = value;
      return await load();
    } finally {
      if (previous === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
  };

  const loadCspUnder = (value: string | undefined): Promise<typeof import('./csp')> =>
    loadUnderNodeEnv(value, () => import('./csp'));

  /**
   * 🔴 **ローダ自身の下界（実測 N68 / N69 が生存して分かった）。**
   *
   * 「モジュールを評価し直す」と「差し替えが**評価の瞬間**に効いている」は、
   * **評価時に env を読むモジュール**が 1 つ無いと観測できない ——
   * 今日の `csp.ts` は `NODE_ENV` を関数スコープでしか読まないので、
   * `vi.resetModules()` を外しても `await` を外側へ出しても**何も落ちなかった**。
   * `tests/fixtures/node-env-probe.ts` が評価時の値を記録するので、両方が赤くなる。
   */
  it('🔴 loadUnderNodeEnv はモジュールを評価し直し、評価の瞬間に NODE_ENV が効いている（機構の下界）', async () => {
    for (const value of ['production', 'development', 'test']) {
      const probe = await loadUnderNodeEnv(value, () => import('../../../tests/fixtures/node-env-probe'));
      expect(probe.NODE_ENV_AT_EVALUATION, `NODE_ENV=${value} が評価時に効いていない`).toBe(value);
    }
    vi.resetModules();
  });

  it('🔴 buildCsp の出力は NODE_ENV に一切依存しない（モジュールスコープの読みも含む）', async () => {
    // 下界: 本番の値を当てていること（これが抜けると族ごと素通りする）。
    expect(NODE_ENV_VALUES).toContain('production');
    expect(NODE_ENV_VALUES).toContain(undefined);
    const mods = new Map<string | undefined, typeof import('./csp')>();
    for (const value of NODE_ENV_VALUES) mods.set(value, await loadCspUnder(value));
    for (const opts of allOptionCombos()) {
      const base = withNodeEnv('test', () => mods.get('test')!.buildCsp(nonce, opts as CspOpts));
      for (const value of NODE_ENV_VALUES) {
        expect(
          withNodeEnv(value, () => mods.get(value)!.buildCsp(nonce, opts as CspOpts)),
          `NODE_ENV=${String(value)} / ${JSON.stringify(opts)} で出力が変わった`,
        ).toBe(base);
      }
    }
    vi.resetModules();
  });

  it('🔴 cspOptionsFor の NODE_ENV 依存は dev の 1 ビットだけ（モジュールスコープの読みも含む）', async () => {
    for (const value of NODE_ENV_VALUES) {
      const mod = await loadCspUnder(value);
      for (const pathname of ['/', '/kiosk', '/kiosk/signage', '/staff/calls/probe-id', '/admin/demo/preview']) {
        expect(
          withNodeEnv(value, () => mod.cspOptionsFor(pathname)),
          `NODE_ENV=${String(value)} / ${pathname}`,
        ).toEqual({
          dev: value === 'development',
          frameAncestors: pathname === '/admin/demo/preview' ? 'self' : 'none',
        });
      }
    }
    vi.resetModules();
  });

  it('🔴 csp.ts が実行時に読む環境変数は NODE_ENV だけ（綴りに依存しない）', async () => {
    const keys = await envKeysReadBy((mod) => {
      for (const opts of allOptionCombos()) mod.buildCsp(nonce, opts as CspOpts);
      for (const pathname of ['/', '/kiosk', '/admin/demo/preview', '/demo/probe-token']) {
        mod.cspOptionsFor(pathname);
      }
    });
    // 下界: 記録器が実際に動いている（空なら主張が空虚に通る）。
    expect(keys).toContain('NODE_ENV');
    expect(keys.filter((key) => key !== 'NODE_ENV')).toEqual([]);
  });

  /**
   * 🔴 **下界は「本物の記録器」を通す（レビュー 12 周目 MINOR 1）。**
   * 当初この下界は Proxy を**その場で書き直した手写しコピー**を検査しており、
   * `envKeysReadBy` 本体を守っていなかった。実測: 本体から `has` トラップだけを
   * 削除する変異が**生存**した（`'X' in process.env` の綴りを取りこぼす）。
   * `run` の中で 4 綴りを叩き、**返り値**に現れることを主張する。
   */
  it('🔴 記録器は綴りを問わず拾う（ドット / 角括弧 / 分割代入 / in）', async () => {
    const keys = await envKeysReadBy(() => {
      void process.env.PROBE_DOT;
      void process.env['PROBE_BRACKET'];
      const { PROBE_DESTRUCTURED } = process.env;
      void PROBE_DESTRUCTURED;
      void ('PROBE_IN' in process.env);
    });
    expect(keys).toEqual(
      expect.arrayContaining(['PROBE_DOT', 'PROBE_BRACKET', 'PROBE_DESTRUCTURED', 'PROBE_IN']),
    );
  });

  it('🔴 opts の直積が全域を覆っている（I1/I2 の機構の下界）', () => {
    const combos = allOptionCombos();
    // 1（opts 自体を渡さない）＋ dev 3 通り × frameAncestors 3 通り。
    expect(combos).toHaveLength(10);
    expect(combos).toContain(undefined);
    for (const key of CSP_OPTION_KEYS) {
      for (const value of OPTION_VALUES[key]) {
        expect(
          combos.some((c) => c !== undefined && c[key] === value),
          `${key}=${String(value)} が直積に無い`,
        ).toBe(true);
      }
    }
  });

  /**
   * 🔴 **直積の「非空虚性」（レビュー 10 周目 BLOCKER 1）。**
   *
   * `toHaveLength(10)` は**個数**しか見ない。個数は積なので、新しいキーを
   * **`[undefined]` 1 個だけ**で足すと 1×3×3+1 = 10 のまま通る。実測: そうやって
   * `sdkOrigins?: readonly string[]` を足し、`proxy.ts` で env から供給する変異が
   * **tsc 0 / unit 8842 本とも全緑**だった —— I3（型）は「キーを宣言したので」黙り、
   * I1/I2 は「緩和側の枝を一度も踏まない」ので黙る。**本番だけが全ルートに `*` を配る。**
   *
   * 各キーが**出力を実際に動かす値**を 1 つ以上持つことを縛れば、その枝は必ず踏まれ、
   * 踏まれた先は `unboundedSources`（I1）が捕まえる。
   */
  it('🔴 各キーは未指定（undefined）を含む（既定値の側にも緩和を仕込めるため）', () => {
    for (const key of CSP_OPTION_KEYS) {
      expect(OPTION_VALUES[key], `${key} が未指定のケースを持たない`).toContain(undefined);
    }
  });

  it('🔴 各キーは出力を実際に動かす値を持つ（直積の非空虚性）', () => {
    const base = buildCsp('test-nonce');
    for (const key of CSP_OPTION_KEYS) {
      expect(
        OPTION_VALUES[key].some((v) => buildCsp('test-nonce', { [key]: v } as CspOpts) !== base),
        `${key} は出力を一度も動かさない（緩和を仕込んでも直積が空虚に通る）`,
      ).toBe(true);
    }
  });

  it('🔴 buildCsp の出力は、opts のどの組合せでも絞られていない source を持たない（I1 / ZAP 10055）', () => {
    for (const opts of allOptionCombos()) {
      expect(unboundedSources(buildCsp(nonce, opts as CspOpts)), JSON.stringify(opts)).toEqual([]);
    }
    // 🔴 期待値そのものにも当てる（同じ供給源に依存する共通モード故障を避ける）。
    expect(unboundedSources(EXPECTED_PROD_CSP)).toEqual([]);
  });

  /**
   * 🔴 **I2: ディレクティブ名も allowlist にする（レビュー 8 周目 BLOCKER 2）。**
   *
   * `unboundedSources` は引用トークンを**無条件に通す**ので、
   * 「引用キーワードだけの新しいディレクティブ」は完全に素通りしていた。実測:
   * `script-src-elem 'self' 'unsafe-inline'` を足す相関変異が unit 8824・e2e 29 とも緑で、
   * **nonce 無しの inline script が実際に実行された**（負の対照として素のビルドでは実行されない）。
   * `-elem` は CSP3 で `<script>` / `<style>` 要素について `script-src` / `style-src` を
   * **上書きする**ので、本体を 1 文字も触らずに #200 / #289 を無効化できる。
   *
   * source を allowlist へ裏返したのと**同じことをディレクティブ名にもやる**。
   * 「新しいディレクティブを足すなら個別テストも足す」という**散文の約束を機械にする**。
   */
  const PINNED_DIRECTIVE_NAMES = [
    'default-src',
    'script-src',
    'style-src',
    'style-src-attr',
    'img-src',
    'font-src',
    'connect-src',
    'media-src',
    'object-src',
    'base-uri',
    'form-action',
    'frame-ancestors',
  ];

  it('🔴 ディレクティブ名の集合は、opts のどの組合せでも固定である（I2）', () => {
    for (const opts of allOptionCombos()) {
      expect([...directivesOf(buildCsp(nonce, opts as CspOpts)).keys()], JSON.stringify(opts)).toEqual(
        PINNED_DIRECTIVE_NAMES,
      );
    }
  });

  /**
   * 🔴 **I2 の下界。** 上は「固定リストと一致する」としか言っていないので、
   * **固定リスト自体に危険な名前が入っていたら**空虚に満たせる。
   * 既存ディレクティブを上書きしうる名前が入っていないこと、および
   * それらを足すと実際にキー集合が動く（＝固定が load-bearing）ことを示す。
   */
  it.each(['script-src-elem', 'style-src-elem', 'script-src-attr', 'worker-src', 'frame-src'])(
    '🔴 %s は固定リストに無く、足せば I2 が落ちる（既存ディレクティブを上書きしうる形）',
    (name) => {
      expect(PINNED_DIRECTIVE_NAMES).not.toContain(name);
      const withExtra = `${buildCsp(nonce)}; ${name} 'self' 'unsafe-inline'`;
      expect([...directivesOf(withExtra).keys()]).not.toEqual(PINNED_DIRECTIVE_NAMES);
    },
  );

  /**
   * 🔴 **下界（負の対照）。** 上だけなら「常に空を返す」実装でも満たせる。
   *
   * 🔴 **2 つの allowlist を「広げる」変異も、ここが下界になる。** 実測で
   * `ALLOWED_SCHEME_BY_DIRECTIVE` の集合に 1 つ足すだけの変異が**素通り**していた
   * （`connect-src` に `data:`、`font-src` に `https:` 等。レビュー 6 周目）。
   * 許可リストに実在する各エントリについて、**そこに無いスキーム**を 1 行ずつ置く。
   */
  it.each([
    "script-src 'self' https:",
    "script-src 'self' *",
    "connect-src 'self' https://*",
    "connect-src 'self' https://*:443",
    "connect-src 'self' https://*/x",
    "media-src 'self' *:*",
    "script-src 'self' HTTPS:",
    "connect-src 'self' https://*.com",
    // スキームの例外は**ディレクティブごと**。nonce CSP を丸ごと迂回できる形。
    "script-src 'self' data:",
    "script-src 'self' blob:",
    // 🔴 **許可リストの各エントリの下界（広げる変異を殺す）。**
    //    エントリごとに「そこに無いスキーム」を置く。`https:` はどこにも許可が無いので
    //    4 エントリ全部に置く —— 1 つでも欠けると、その行を広げる変異が素通りした
    //    （実測: `font-src` に `https:` を足す変異が生存。レビュー 6 周目）。
    "connect-src 'self' data:",
    "connect-src 'self' https:",
    "media-src 'self' blob:",
    "media-src 'self' https:",
    "font-src 'self' blob:",
    "font-src 'self' https:",
    "img-src 'self' https:",
    // 🔴 引用判定（`/^'[^']*'$/`）の下界。緩める変異（`/^'/` 等）を殺す。
    "img-src 'self' 'x'y",
    // 🔴 **ホストは 1 つも許可していない（今日）。** 形では判定しないので、
    //    具体ホストもサブドメインワイルドカードも「絞られていない」と出る。
    //    増分 2 が許可するときは `ALLOWED_SOURCES` へ明示的に足す＝判断が diff に出る。
    //
    //    🔴 **ここに「増分 2 が許可するホスト」を書かない。** 一度
    //    `https://static.opentok.com` を置いたところ、増分 2 の正当な作業
    //    （CSP・期待値・許可リストの 3 点を揃える）で**この行が落ちた** ——
    //    検査が仕事を妨げる形（実測。レビュー 6 周目）。**無関係なホストで書く。**
    "connect-src 'self' https://evil.example.com",
    "connect-src 'self' https://*.evil.example.com",
    "connect-src 'self' https://example.com:443",
    "connect-src 'self' ws://localhost:3000",
    // source 以外の値を持つディレクティブも、今日は許可リストに無いので出る。
    // 増分 2 で CSP レポートを入れるなら、そのとき明示的に足す判断になる。
    'report-uri /api/csp-report',
    'sandbox allow-scripts',
    // 🔴 **走査ループそのものの下界（レビュー 8 周目 MAJOR 1）。**
    //    ここまでの負の対照は**全部「1 ディレクティブだけの文字列」**で、違反トークンが
    //    常に 1 本目の行に在った。そのため `csp.split(';')` を `.slice(0, 1)` に縮める変異が
    //    **生存**していた（実測 45 tests 全 PASS）—— 縮んだ後は実 CSP の `default-src` しか
    //    見ないので、`connect-src` に `https://*` と `*` を配りながら完全に無言になる。
    //    **違反を 1 本目以外に置いた行**を入れて、ループの全周を load-bearing にする。
    "default-src 'self'; connect-src 'self' https://*",
    "default-src 'self'; style-src 'self'; script-src 'self' *",
    "default-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' https:",
  ])('🔴 %s は絞られていない source として出る（負の対照）', (csp) => {
    expect(unboundedSources(csp).length).toBeGreaterThan(0);
  });

  it.each([
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "media-src 'self' data:",
    "style-src-attr 'unsafe-inline'",
    "frame-ancestors 'none'",
  ])('%s は絞られている（通す）', (csp) => {
    expect(unboundedSources(csp)).toEqual([]);
  });

  it('既存の堅牢化ディレクティブを維持する（#6/#31 と同等）', () => {
    const csp = buildCsp(nonce);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).toContain("media-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 🔴 **`default-src` だけ「値の完全一致」を持つ（レビュー 6 周目）。**
    // `toContain` は部分一致なので、`default-src 'self' 'unsafe-inline'` のような
    // **足す**変異を巻き添えにしない。`script-src` / `style-src` は個別テストが
    // 値まで見ているのに `default-src` だけ非対称だった —— 未指定ディレクティブ
    // （`worker-src` / `frame-src` / `manifest-src` …）のフォールバック元なので効く。
    expect(directivesOf(csp).get('default-src')).toEqual(["'self'"]);
  });

  it('🔴 本番で配る CSP を 1 文字ずつ固定する（#6/#31/#200/#289/#1132）', () => {
    expect(buildCsp('test-nonce')).toBe(EXPECTED_PROD_CSP);
  });

  /**
   * 🔴 **変種は「全文」ではなく「prod との差分」で縛る。**
   *
   * 当初は `EXPECTED_PROD_CSP.replace(...)` で dev / frameAncestors の期待値を作っていたが、
   * それだと **CSP にホストを 1 つ足しただけで挿入位置がずれて落ちる** ——
   * 増分 2 の**正当な作業**を検査が妨げる形になっていた（変異 C18 の実測）。
   * `replace` はアンカーが無くても例外を出さず元の文字列を返すので、静かに別物にもなる。
   *
   * ここで縛りたいのは全文ではなく「**緩和がどのディレクティブに、何を足すか**」である。
   * 差分で書けば、他のディレクティブが正当に変わっても揺れない。
   *
   * 🔴 **方式を替えて落ちた保証を明記する（レビュー 4 周目）。** `added` / `removed` は
   * 集合なので、**変種における token の順序入替と重複**は縛らなくなった
   * （`script-src 'nonce-x' 'unsafe-eval' 'self'` / `'self' 'self'`）。
   * prod は全文固定なので prod 側は無傷であり、CSP の意味も変わらないため許容する。
   */
  const directivesOf = (csp: string): Map<string, string[]> =>
    new Map(
      csp.split(';').map((d) => {
        const tokens = d.trim().split(/\s+/);
        return [tokens[0] ?? '', tokens.slice(1)] as const;
      }),
    );

  /** `base` と `variant` で**中身が違う**ディレクティブだけを、増減つきで返す。 */
  function directiveDiff(base: string, variant: string): Record<string, { added: string[]; removed: string[] }> {
    const a = directivesOf(base);
    const b = directivesOf(variant);
    // 🔴 ディレクティブ自体の増減も見る（行を足す／落とす変異を見逃さない）。
    expect([...b.keys()]).toEqual([...a.keys()]);
    const out: Record<string, { added: string[]; removed: string[] }> = {};
    for (const [name, tokens] of b) {
      const before = a.get(name) ?? [];
      const added = tokens.filter((t) => !before.includes(t));
      const removed = before.filter((t) => !tokens.includes(t));
      if (added.length > 0 || removed.length > 0) out[name] = { added, removed };
    }
    return out;
  }

  /**
   * 🔴 **`directiveDiff` が守っている不変条件を先に書く（レビュー 5 周目）。**
   * 「ディレクティブの集合が変わらない」という行は load-bearing（行を落とす変異を殺す）
   * なのに、**その行自体を消す変異が生存**していた＝守っている条件が書かれていなかった。
   */
  it('🔴 directiveDiff はディレクティブが増減したら落ちる（機構の下界）', () => {
    const base = buildCsp('test-nonce');
    // 🔴 **プローブは衝突しえない形で作る（レビュー 6 周目）。**
    // 当初は `object-src` を名指しで落とし、`worker-src 'self'` を足していたが、
    // どちらも**増分 2 が実際に触りうる名前**なので、`object-src` を落とす／
    // `worker-src` を足す正当な変更で `fewer === base` / キー重複になり、
    // **欠陥ではなく fixture のせいで赤くなる**（4 周目に潰した型の再発）。
    const fewer = base.split('; ').slice(0, -1).join('; ');
    expect(() => directiveDiff(base, fewer)).toThrow();
    const more = `${base}; x-review-probe 'none'`;
    expect(() => directiveDiff(base, more)).toThrow();
  });

  it('🔴 dev の緩和は 2 つだけ（script-src の unsafe-eval と style-src の unsafe-inline）', () => {
    expect(directiveDiff(buildCsp('test-nonce'), buildCsp('test-nonce', { dev: true }))).toEqual({
      'script-src': { added: ["'unsafe-eval'"], removed: [] },
      'style-src': { added: ["'unsafe-inline'"], removed: [] },
    });
  });

  it('🔴 frameAncestors の緩和は frame-ancestors 1 行だけに効く (#363)', () => {
    expect(directiveDiff(buildCsp('test-nonce'), buildCsp('test-nonce', { frameAncestors: 'self' }))).toEqual({
      'frame-ancestors': { added: ["'self'"], removed: ["'none'"] },
    });
  });

  /**
   * 🔴 **`cspOptionsFor` は pathname だけを受け取る（レビュー 10・11 周目）。**
   * 導出を `proxy.ts` からこのモジュールへ移したので、**リクエストの形を引数で渡せない**。
   * env の面は別の機構が見る（上の実行時記録器と、`proxy.test.ts` の毒値の負の対照）——
   * この関数自身が `NODE_ENV` を読むので**純関数ではない**。
   * ここで縛るのは「どの経路がどう緩むか」の全体である。
   */
  describe('cspOptionsFor', () => {
    it('🔴 iframe 埋め込みを許すのはプレビュー 1 経路だけ (#363)', () => {
      expect(cspOptionsFor('/admin/demo/preview')).toEqual({ dev: false, frameAncestors: 'self' });
    });

    it.each([
      '/',
      '/kiosk',
      '/kiosk/signage',
      '/admin/demo',
      '/admin/demo/preview/',
      '/admin/demo/preview/x',
      '/demo/probe-token',
      '/staff/calls/probe-id',
    ])('🔴 %s は iframe 埋め込みを許さない（前方一致で漏れない）', (pathname) => {
      expect(cspOptionsFor(pathname).frameAncestors).toBe('none');
    });

    it('🔴 unit は開発モードではないので dev 緩和は乗らない', () => {
      expect(process.env.NODE_ENV).not.toBe('development');
      expect(cspOptionsFor('/').dev).toBe(false);
    });

    it('🔴 返すキーは buildCsp のオプションと一致する（配線の取りこぼしを作らない）', () => {
      expect(Object.keys(cspOptionsFor('/')).sort()).toEqual([...CSP_OPTION_KEYS].sort());
    });
  });

  it('frameAncestors 未指定の既定は none（全ルート iframe 拒否を維持）', () => {
    expect(buildCsp(nonce, {})).toContain("frame-ancestors 'none'");
  });

  it("frameAncestors='self' でプレビュー用の同一オリジン埋め込みだけ許可できる (#363)", () => {
    const csp = buildCsp(nonce, { frameAncestors: 'self' });
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it('開発時のみ unsafe-eval を許可する（React のデバッグ用 eval）', () => {
    expect(buildCsp(nonce, { dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp(nonce)).not.toContain("'unsafe-eval'");
    expect(buildCsp(nonce, { dev: false })).not.toContain("'unsafe-eval'");
  });
});
