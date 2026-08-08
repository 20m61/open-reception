import { describe, expect, it } from 'vitest';
import { describeCommandFailure } from './command-failure';

/**
 * 外部コマンド失敗の説明文 (#656)。
 *
 * **3 周ぶん、実際のエラー本文を一度も見ないまま修正を当てていた。** `execFileSync` の
 * 例外の `message` は `Command failed: <cmd>` までで、理由（`remote: Repository not found.`
 * 等）は `stderr` にある。拾っていなかったので、クラウドで何が起きているのか分からないまま
 * `gh repo view` → `git symbolic-ref` → `git ls-remote` と当て推量を重ねる羽目になった。
 */

/** `execFileSync` が投げる例外を模した最小の形。 */
function failure(stderr?: string | Buffer): unknown {
  const e = new Error('Command failed: gh pr list --head x');
  return Object.assign(e, stderr === undefined ? {} : { stderr });
}

describe('describeCommandFailure', () => {
  it('stderr の内容を説明に含める', () => {
    // これが無いと「失敗した」しか分からず、原因の切り分けに一切使えない。
    const s = describeCommandFailure('gh pr list --head x', failure('gh: not authenticated'));
    expect(s).toContain('gh pr list --head x');
    expect(s).toContain('gh: not authenticated');
  });

  it('stderr が無ければコマンドだけを出す', () => {
    // `undefined` や `null` の文字列を混ぜない（何が起きたか分からない上に読みづらい）。
    const s = describeCommandFailure('gh pr list --head x', failure());
    expect(s).toBe('gh pr list --head x');
  });

  it('Buffer の stderr も読む', () => {
    // `stdio: 'pipe'` の encoding 次第で Buffer が来る。String() を通さないと
    // `[object Object]` になり、**stderr を拾ったつもりで拾えていない**状態になる。
    const s = describeCommandFailure('git ls-remote', failure(Buffer.from('fatal: not a git repo')));
    expect(s).toContain('fatal: not a git repo');
  });

  it('長い stderr は先頭数行に切る', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const s = describeCommandFailure('git ls-remote', failure(many));
    expect(s).toContain('line0');
    expect(s).toContain('line2');
    expect(s).not.toContain('line3');
  });

  it('URL に埋め込まれた資格情報を伏せる', () => {
    // 🔴 **クラウドの remote は `https://x-access-token:<token>@github.com/...` の形を取る**。
    // stderr がその URL を echo すると、この説明文は PR 本文や監査ログへ運ばれるので
    // **トークンがそのまま外へ出る**。`rules/pii-secret-minimization.md` に反する。
    const s = describeCommandFailure(
      'git ls-remote',
      failure('fatal: could not read https://x-access-token:ghs_SECRETVALUE@github.com/o/r.git'),
    );
    expect(s).not.toContain('ghs_SECRETVALUE');
    expect(s).not.toContain('x-access-token');
    expect(s).toContain('https://***@github.com/o/r.git');
  });

  it('資格情報を含まない URL は壊さない', () => {
    const s = describeCommandFailure('git ls-remote', failure('fatal: https://github.com/o/r.git'));
    expect(s).toContain('https://github.com/o/r.git');
  });

  it('コマンド文字列側の資格情報も伏せる', () => {
    // 呼び出し側が URL を引数に渡すこともある（明示 URL の ls-remote 等）。
    const s = describeCommandFailure(
      'git ls-remote https://user:pw@github.com/o/r.git',
      failure('boom'),
    );
    expect(s).not.toContain('pw@');
    expect(s).toContain('https://***@github.com/o/r.git');
  });
});
