/**
 * 退館フローの `fetch` を「読み取り / 書き込み」へ分類する (#1029)。
 *
 * ## なぜモジュールへ出したか
 *
 * 🔴 **分類の綴りを 5 回替え、5 回とも別の側を壊した。**
 *
 * | 周 | 方式 | 何が起きたか |
 * | --- | --- | --- |
 * | 4 | `AbortSignal.timeout(` のリテラル一致 | 変数へ持ち上げると見逃す |
 * | 5 | 一意束縛 | 内側スコープの影付けで見逃す |
 * | 6 | `method: 'POST'` の綴り | `const POST = 'POST'` で見逃す |
 * | 6 | `method` キーの有無 | **`method: 'GET'` を書き込みと誤判定**（偽陽性） |
 * | 7 | `body:` の有無 | **body なしの書き込み**（query 文字列）を見逃す |
 * | 9 | `method:` を `body:` より先に見る | **`body` の中に入れ子で現れた `method`** を
 *       fetch の method と取り違え、`{ body: JSON.stringify({ method: 'get' }), method: 'POST' }`
 *       を読み取りと誤判定（7 周目の `body:` 規則が kill していた入力を落とした = 退行） |
 *
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、前の方式が守っていた変異を
 * 当て直す」に毎回当たっており、#813（ESLint の文法を手写しして 3 度突破された）と同型である。
 * **綴りを 6 個目に替えるのをやめる。**
 *
 * ## 代わりに何をするか
 *
 * 1. **文字列定数を先に解決する。** `const RESOLVE_URL = '/api/...'` を実体へ置き換えてから
 *    判定するので、括り出しという**振る舞いを変えない書き換え**で分類が変わらない
 * 2. **過去の変異を fixture として `checkout-deadline-scan.test.ts` に保持する。**
 *    方式を替えるときは全部当て直すことが強制される —— 見逃しと偽陽性の**両方向**を
 *    1 つの表で持つ（片方だけ測るのが 5 回の失敗の共通点だった）
 * 3. **綴りではなく意味規則を、強い順に並べる**（9 周目）。「経路 > 本文の有無 >
 *    リテラルの method > 読めない init」であって、`method` の書き方の列挙ではない。
 *    上の表の 6・7 行目は「規則の順序」を綴りの問題として扱ったために起きている
 *
 * ## 🔴 何を保証し、何を保証しないか（誇張しない）
 *
 * **保証する**: 振る舞いを変えない書き換えのうち、**URL・method 値の定数への括り出し**、
 * **本文を運ぶ要求の綴り**（shorthand / 引用符付きキー / 入れ子）、**spread による初期化**は
 * 分類を変えない。読めない init は必ず書き込み側（長い締切）へ倒れるので、**誤ると
 * 「待ちすぎる」側**であり、「サーバの予算より先に諦めて成功を否定する」側には倒れない。
 *
 * **保証しない**: `args` の外に置かれた init（別ファイルの定数・関数の戻り値）は読めない。
 * `fetch(url, buildInit())` は `method` も `body` も `...` も現れないので**読み取りへ落ちる**。
 * また `resolveConstants` は素朴な置換なので、**文字列リテラルの内側**に識別子と同じ綴りが
 * あれば置き換わる（実測: `` `?stayId=${id}` `` は `const stayId` があるとキー側まで置換される）。
 * いまは分類が変わる入力を作れていないが、これも方式の限界であって行を足せば直らない。
 * 源泉から断つには「退館ディレクトリで素の `fetch` を禁止し、経路から締切を決める helper
 * だけを通す」という前提の置き換えが要る（#1040）。ここは**その前段の緩和**である。
 */

/** `const X = '...'` の文字列定数（`args` に現れる識別子を実体へ戻すため）。 */
export function stringConstants(source: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(['"`])([^'"`]*)\2/g)) {
    out.set(m[1] as string, m[3] as string);
  }
  return out;
}

/** `args` 中の識別子を、同じファイルの文字列定数で置き換える。 */
export function resolveConstants(args: string, constants: ReadonlyMap<string, string>): string {
  let out = args;
  for (const [name, value] of constants) {
    out = out.replace(new RegExp(`(?<![\\w$.'"\`])${name}(?![\\w$])`, 'g'), `'${value}'`);
  }
  return out;
}

/** 退館フローの締切の種類。 */
export type DeadlineKind = 'read' | 'confirm';

/**
 * この `fetch` 引数が読み取りか書き込みか。
 *
 * - `/checkout/confirm` … 退館を確定する書き込み
 * - `/checkout/resolve` … 自己特定。POST だが退館は確定しないので**読み取り**
 * - それ以外 … **強い順に**「本文を運ぶか > `method` のリテラル > `method` の言及や spread」。
 *   本文を運ぶ要求は書き込み、`method: 'GET'` は読み取り、読めない init は書き込みへ倒す
 *
 * 🔴 呼ぶ前に `resolveConstants` を通すこと。通さないと URL を定数へ括り出す**等価変換**で
 * 分類が変わる（8 周目 MINOR-2 の実測）。
 */
export function classifyDeadline(resolvedArgs: string): DeadlineKind {
  // 1. 経路が分かるならそれが最も強い。
  if (resolvedArgs.includes('/checkout/confirm')) return 'confirm';
  if (resolvedArgs.includes('/checkout/resolve')) return 'read';
  // 2. 本文を運ぶ要求は書き込みである（GET は本文を運ばない）。**`method` より先に見る。**
  if (/\bbody\s*:/.test(resolvedArgs)) return 'confirm';
  // 3. `method` がリテラルで読めるなら、それに従う。
  const method = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(resolvedArgs);
  if (method !== null) return method[1]?.toUpperCase() === 'GET' ? 'read' : 'confirm';
  // 4. `method` の言及はあるが読めない（shorthand・動的・計算キー）、または spread で
  //    初期化が読めない。**読めない init は書き込み側へ倒す。**
  if (/\bmethod\b/.test(resolvedArgs) || resolvedArgs.includes('...')) return 'confirm';
  // 5. 経路も method も本文も無い ―― `fetch(url, { signal })` の素の GET。
  return 'read';
}
