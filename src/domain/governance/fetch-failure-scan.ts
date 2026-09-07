/**
 * 通信失敗が無言にならないことを機械で見るための**走査**（#968 / #973）。
 *
 * ## なぜ共有モジュールなのか
 *
 * 元は `tests/config/platform-fetch-failure.test.ts` の中にあった。#973 が同じ検査を
 * `src/components/admin/**` へ広げるにあたり、**写しを作らずに**母集団だけを差し替える。
 * 写しを作ると、片方に入った修正（このファイルのコメントが記録している欠陥のどれか）が
 * もう片方へ入らず、しかも誰も気づかない。
 *
 * ## ここに書いてあるコメントは「過去に踏んだ欠陥」の記録である
 *
 * 走査を書き換えるときは、コメントが名指ししている失敗を**当て直す**こと
 * （`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、前の方式が守っていた変異を
 * 当て直す」）。どれも独立レビューが実測で見つけたもので、思いつきでは再発見できない。
 *
 * I/O は持たない（ファイルを読むのは呼び出し側）。ここは文字列を解釈するだけ。
 */

/** 行コメント / ブロックコメントを落とす（URL の `//` は残す）。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 文字列 / テンプレートリテラルの終端（閉じ引用符）の位置。`${}` の入れ子も飛ばす。 */
export function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === quote) return i;
    if (quote === '`' && c === '$' && source[i + 1] === '{') {
      const end = matchBrace(source, i + 1);
      if (end < 0) return source.length;
      i = end - 1;
    }
  }
  return source.length;
}

/** `from`（`{` の位置）に対応する `}` の**次**の位置。見つからなければ -1。 */
export function matchBrace(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export type Block = { readonly start: number; readonly end: number };

/** `try { … } catch (…) { … }` の try 本体と catch 本体。入れ子も全部返す。 */
export function tryCatchBlocks(source: string): { readonly tryBody: Block; readonly catchBody: Block }[] {
  const out: { tryBody: Block; catchBody: Block }[] = [];
  for (const m of source.matchAll(/\btry\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const tryEnd = matchBrace(source, open);
    if (tryEnd < 0) continue;
    const rest = source.slice(tryEnd);
    const catchHead = /^\s*catch\s*(\([^)]*\)\s*)?\{/.exec(rest);
    if (!catchHead) continue;
    const catchOpen = tryEnd + catchHead[0].length - 1;
    const catchEnd = matchBrace(source, catchOpen);
    if (catchEnd < 0) continue;
    out.push({ tryBody: { start: open, end: tryEnd }, catchBody: { start: catchOpen, end: catchEnd } });
  }
  return out;
}

/**
 * `fetch(` の**対応する閉じ括弧**までを返す (#968 レビュー 7 周目)。
 *
 * 🔴 最初は `indexOf('{', open)` から `matchBrace` していたが、URL が
 * テンプレートリテラルだと **`${` の波括弧に当たって**引数を短く切り、
 * `signal:` を持つ呼び出しを「持っていない」と誤判定した（自作の検出器が
 * 誤報を出した実例）。括弧の対応で取る。
 */
export function fetchArguments(source: string, site: number): string {
  const open = source.indexOf('(', site);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      // `skipString` は閉じ引用符の**位置**を返す。`matchBrace` と同じく、
      // ループの `i += 1` で次へ進める（`- 1` すると閉じ引用符を再び開始と読む）。
      i = skipString(source, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

export function fetchSites(source: string): number[] {
  return [...source.matchAll(/(?<![\w$.])(?:(?:window|globalThis|self)\.)?fetch\s*\(/g)].map(
    (m) => m.index ?? 0,
  );
}

/**
 * 失敗を**画面へ出す**呼び出し。**閉じた語彙にする** —— 「何か書いてあればよい」に
 * すると `void 0;` 変異の代わりに `noop();` を書けば通ってしまう。
 *
 * 🔴 **引数まで見る (#968 レビュー B2)。** 呼び出し名だけを見ると
 * `setError(null)` / `setActionError('')` が通る —— 画面出力は「報告しない」と
 * **完全に同一**（`{error ? … }` は `null` も `''` も falsy）なのに、検査は満たされる。
 * `void 0;` という**1 つの綴り**を閉じただけで族が閉じていなかった、という指摘そのもの。
 * 中身のある値（文字列リテラル・テンプレート・オブジェクト・関数呼び出し）を要求する。
 */
const FAILURE_CALL = /\b(?:set[A-Za-z]*(?:Error|Failed|Failure)|failure)\s*\(/g;

/**
 * **画面に何も出ない**引数 (#968 レビュー m-2)。
 *
 * 最初は `null` / `undefined` / `''` / `""` / `` `` `` / `false` を列挙して弾いていたが、
 * 独立レビューが `setActionError(' ')`（**空白 1 文字**）を当てて生存させた —— 空白だけの
 * 文字列は truthy なので `{actionError ? …}` は真になり、`role="alert"` の**空の段落**が
 * 描かれる。画面にも読み上げにも何も出ないのに、検査は「報告している」と判定する。
 *
 * 引用符の**中身が空白だけ**であることまで見る形へ替えた（`\s*` を挟む）。逆に、計算された
 * 式（三項・関数呼び出し・オブジェクト）は静的には空かどうか判定できないので**通す** ——
 * ここで閉じられるのは「リテラルとして空」の族だけである、と明示しておく。
 */
const EMPTY_ARGUMENT = /^\s*(?:null|undefined|false|0|(['"`])\s*\1)\s*[,)]/;

/**
 * **無条件の `throw` / `return` より後ろ**は到達しない (#973)。
 *
 * 🔴 `catch (e) { throw e; setError('…'); }` は、報告の呼び出しが**在る**のに一度も
 * 実行されない。呼び出しの有無だけを見ていたときは変異が生存した（実測）。
 * `.claude/rules/opus5-autonomous-loop.md` が必須としている「**早期 return が後段を
 * 飲み込む**」型そのもの。
 *
 * 条件付きの早期 return（`if (cancelled) return;` —— 世代ガードの定型）は**切らない**。
 * 切ると、正しく書かれた `catch` を「報告していない」と誤判定する。直前の非空白文字が
 * `{` / `;` / `}` のものだけを「無条件」とみなす（`if (…) return;` は `)` なので外れる）。
 */
function reachableBody(body: string): string {
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(body, i);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    // catch 本体は `{` から始まるので、文の深さは 1。
    if (depth !== 1) continue;
    const rest = body.slice(i);
    const m = /^(?:throw|return)\b/.exec(rest);
    if (m === null) continue;
    const before = body.slice(0, i).replace(/\s+$/, '');
    const prev = before.at(-1);
    if (prev === '{' || prev === ';' || prev === '}') return body.slice(0, i);
  }
  return body;
}

/** 失敗を**画面へ出す**呼び出しが在るか（到達する範囲で）。 */
export function reportsFailure(body: string): boolean {
  const reachable = reachableBody(body);
  for (const m of reachable.matchAll(FAILURE_CALL)) {
    const rest = reachable.slice((m.index ?? 0) + m[0].length);
    if (!EMPTY_ARGUMENT.test(rest)) return true;
  }
  return false;
}

/** `catch` の中で呼ばれている報告先 setter 名（`setError` → `error`）。 */
export function reportedStates(body: string): string[] {
  return [...body.matchAll(/\bset([A-Z][A-Za-z]*(?:Error|Failed|Failure))\s*\(/g)].map(
    (m) => `${(m[1] ?? '').charAt(0).toLowerCase()}${(m[1] ?? '').slice(1)}`,
  );
}

/**
 * 三項の条件から JSX を出している state 名（`ident ? <…>` / `ident !== null ? (<…>`）。
 *
 * 🔴 **先頭の `{` を要求しない。** 三項を連ねると 2 段目以降は `) : ident !== null ? (`
 * の形になり、`{` から始まらない。要求すると**実際に描いているのに「描いていない」**
 * と判定してしまう（`TenantSwitcher` で実際に踏んだ）。
 */
export function renderedStates(source: string): string[] {
  return [...source.matchAll(/([A-Za-z_$][\w$]*)\s*(?:!==\s*null\s*)?\?\s*\(?\s*</g)].map(
    (m) => m[1] ?? '',
  );
}
