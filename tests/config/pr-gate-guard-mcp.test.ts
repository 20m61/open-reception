/**
 * ゲートガードが **GitHub MCP 経路も**捕まえること (#736)。
 *
 * ## 事実
 *
 * このフックは `gh pr merge` → `scripts/merge-pull-request.ts` → 生 REST と、
 * **経路が変わるたびに穴を塞いできた**（#678 / #702）。次の穴は **GitHub MCP ツール**だった。
 *
 * 🔴 `mcp__github__merge_pull_request` は Bash を通らないので `PreToolUse(Bash)` からは
 * 見えない。2026-08-21、`--pr` しか回していない PR がこの経路でマージされ、
 * **main が sast で red になった**（`sast` は `--full` でしか走らない）。
 *
 * 「主経路が移ったら、移した先がそのままゲートの抜け道になる」── フック自身の
 * コメントが 2 度書いていることを、3 度目に踏んだ。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const HOOK = resolve('scripts/hooks/pr-gate-guard.sh');

/**
 * 🔴 **スタンプの無い使い捨て git リポジトリで走らせる。**
 *
 * 最初これを本物のリポジトリで走らせて、**main で赤くなった** ── `--full` を回した直後は
 * スタンプが green なので、ガードは正しく「許可」する。つまりあのテストは
 * 「スタンプがたまたま無い/古い」ことに依存していて、**ガードの判定ではなく実行環境を
 * 測っていた**。今夜追ってきた欠陥（性質を主張しているようで別のものを見ている）そのもの。
 *
 * スタンプは `git rev-parse --absolute-git-dir` 配下に置かれるので、cwd を空の git
 * リポジトリにすれば「記録が無い」状態を決定的に作れる。
 */
let repoWithoutStamp: string;

beforeAll(() => {
  repoWithoutStamp = mkdtempSync(join(tmpdir(), 'gate-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: repoWithoutStamp });
});

/** フックへ PreToolUse のペイロードを渡し、終了コードと stderr を返す。 */
function invoke(payload: object): { code: number; stderr: string } {
  try {
    execFileSync('bash', [HOOK], {
      cwd: repoWithoutStamp,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: err.stderr ?? '' };
  }
}

describe('pr-gate-guard.sh が MCP 経路を見る (#736)', () => {
  /**
   * 🔴 **これが本体。** green な記録が無いのだからブロックされるはず。
   */
  it('🔴 MCP でのマージは --full を要求する', () => {
    const { code, stderr } = invoke({
      tool_name: 'mcp__github__merge_pull_request',
      tool_input: { owner: 'o', repo: 'r', pullNumber: 1 },
    });
    expect(code, 'MCP 経由のマージが素通りしている').toBe(2);
    expect(stderr).toContain('--full');
  });

  it('🔴 MCP での PR 作成は --pr を要求する', () => {
    const { code, stderr } = invoke({
      tool_name: 'mcp__github__create_pull_request',
      tool_input: { owner: 'o', repo: 'r' },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('--pr');
  });

  /**
   * 🔴 広く取りすぎない。読み取り系まで止めると、ガードごと迂回される動機になる
   * （フック自身が「ここを広く取ると誤検出でガードごと迂回される」と書いている）。
   */
  it('🔴 読み取り系の MCP ツールは素通りする', () => {
    for (const tool of ['mcp__github__list_issues', 'mcp__github__pull_request_read']) {
      expect(invoke({ tool_name: tool, tool_input: {} }).code, tool).toBe(0);
    }
  });

  it('Bash 経路は従来どおり（回帰していない）', () => {
    expect(invoke({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --squash' } }).code).toBe(2);
    expect(invoke({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }).code).toBe(0);
  });
});

describe('settings.json が MCP matcher を登録している (#736)', () => {
  /**
   * 🔴 スクリプトが対応していても、**matcher が無ければフックは起動しない**。
   * 「直したつもり」で穴が開いたままになる典型なので、設定側も縛る。
   */
  it('🔴 PreToolUse に GitHub MCP の matcher がある', async () => {
    const settings = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile('.claude/settings.json', 'utf8')),
    ) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };

    const entry = settings.hooks.PreToolUse.find((h) => h.matcher.includes('mcp__github__'));
    expect(entry, 'MCP 用の matcher が無い（フックが起動しない）').toBeDefined();
    expect(entry!.matcher).toContain('merge_pull_request');
    expect(entry!.matcher).toContain('create_pull_request');
    expect(entry!.hooks.some((h) => h.command.includes('pr-gate-guard.sh'))).toBe(true);
  });
});
