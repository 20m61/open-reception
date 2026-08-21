/**
 * PR 作成スクリプトが**入力を黙って落とさない**こと (#736)。
 *
 * ## 事実
 *
 * このスクリプトは長らく未知の引数を無視していた。`--body-file` を渡していた呼び出しは
 * **本文が空のまま PR を作り続け**、書いた根拠（変更理由・変異検証・人間承認の要否）が
 * 1 件も GitHub へ載っていなかった。コミットメッセージ側には残っていたので気づくのが遅れた
 * ── 2026-08-21 に 6 本の PR で実際に起きた。
 *
 * 「渡したのに効かない」は「渡し忘れ」より悪い。**呼び出し側は成功したと思い込む。**
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 引数解析だけを踏む（PR は作らせない）。ゲートガードは対象外なので明示的に外す。 */
function runArgs(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync('npx', ['tsx', 'scripts/create-pull-request.ts', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPEN_RECEPTION_SKIP_GATE_GUARD: '1' },
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('create-pull-request.ts の引数 (#736)', () => {
  /**
   * 🔴 **これが本体。** 知らない引数を無視すると、呼び出し側は渡したつもりで PR が
   * 空本文になる。
   */
  it('🔴 知らない引数を黙って無視しない', () => {
    const { code, output } = runArgs(['--head', 'x', '--title', 'y', '--bogus', 'z']);
    expect(code).not.toBe(0);
    expect(output).toContain('--bogus');
  });

  it('🔴 本文が空のまま PR を作らない', () => {
    const { code, output } = runArgs(['--head', 'x', '--title', 'y']);
    expect(code).not.toBe(0);
    expect(output).toContain('本文が空');
  });

  it('🔴 --body-file を受け付ける（無視しない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-body-'));
    const file = join(dir, 'body.md');
    writeFileSync(file, 'TEST-本文');
    // 引数解析は通り、その先（git remote / gh）で落ちる ＝ 引数エラーではない。
    const { output } = runArgs(['--head', 'x', '--title', 'y', '--body-file', file]);
    expect(output).not.toContain('知らない引数');
    expect(output).not.toContain('本文が空');
  });

  it('--body と --body-file の同時指定を拒否する（どちらが効いたか曖昧にしない）', () => {
    const { code, output } = runArgs([
      '--head', 'x', '--title', 'y', '--body', 'a', '--body-file', '/tmp/nonexistent',
    ]);
    expect(code).not.toBe(0);
    expect(output).toContain('同時に指定できません');
  });
});
