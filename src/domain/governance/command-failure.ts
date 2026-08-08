/**
 * 外部コマンド失敗を「原因が分かる形」で説明する (#656)。
 *
 * ## なぜ要るか
 *
 * `evaluate-gate-runs.ts` は `git` / `gh` を呼び、失敗したら `branch_check_unverified` を
 * 出す。その説明に `execFileSync` の例外の `message` をそのまま載せていたが、
 * **`message` は `Command failed: <cmd>` までで、理由は `stderr` にある**。
 *
 * 結果として、クラウドで検査が到達しない原因を**一度も見ないまま** 3 周にわたって
 * `gh repo view` → `git symbolic-ref` → `git ls-remote` と当て推量を重ねた。
 * 直すべきは 4 つ目のコマンドではなく、**観測**だった。
 *
 * ## 資格情報を持ち出さない
 *
 * この説明文は PR 本文や運用の記録へ運ばれる。クラウドの remote は
 * `https://x-access-token:<token>@github.com/...` の形を取ることがあり、git の stderr は
 * その URL を echo する。**素通しするとトークンが外へ出る**
 * （`.claude/rules/pii-secret-minimization.md`）。URL の資格情報部は必ず伏せる。
 */

/** 説明に載せる stderr の行数。原因は先頭に出るので、これ以上は雑音になる。 */
const MAX_STDERR_LINES = 3;

/**
 * URL に埋め込まれた資格情報（`scheme://user:pass@host`）を伏せる。
 *
 * **`user` だけの形（`https://token@host`）も対象。** GitHub の token 直付けはこの形を取る。
 */
function redactCredentials(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1***@');
}

/**
 * 失敗したコマンドと、その理由（stderr）を 1 行にまとめる。
 *
 * stderr が無ければコマンドだけを返す — `undefined` の文字列を混ぜない。
 */
export function describeCommandFailure(command: string, error: unknown): string {
  const raw = (error as { stderr?: string | Buffer } | null)?.stderr;
  // **Buffer を String() で通す。** そのまま埋めると `[object Object]` になり、
  // 「stderr を拾ったつもりで拾えていない」状態になる（緑の要約と同じ罠）。
  const stderr =
    raw === undefined || raw === null
      ? ''
      : String(raw)
          .trim()
          .split('\n')
          .slice(0, MAX_STDERR_LINES)
          .join(' / ')
          .trim();
  const detail = stderr === '' ? '' : `: ${stderr}`;
  return redactCredentials(`${command}${detail}`);
}
