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
 * - `/api/kiosk/checkout` … `method` が GET（または `method` も `body` も無い）なら読み取り、
 *   それ以外は書き込み。**body の有無だけでは決めない** —— query 文字列で書き込む形を見逃す
 *
 * 🔴 呼ぶ前に `resolveConstants` を通すこと。通さないと URL を定数へ括り出す**等価変換**で
 * 分類が変わる（8 周目 MINOR-2 の実測）。
 */
export function classifyDeadline(resolvedArgs: string): DeadlineKind {
  if (resolvedArgs.includes('/checkout/confirm')) return 'confirm';
  if (resolvedArgs.includes('/checkout/resolve')) return 'read';
  const method = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(resolvedArgs);
  if (method !== null) return method[1]?.toUpperCase() === 'GET' ? 'read' : 'confirm';
  // `method` が読めない（動的な値など）なら、書き込みの疑いがある側へ倒す。
  if (/\bmethod\s*:/.test(resolvedArgs) || /\bbody\s*:/.test(resolvedArgs)) return 'confirm';
  return 'read';
}
