/**
 * `scripts/change-budget.ts` の収集失敗の可視化 (#712)。
 *
 * ## なぜ change-scope より軽いのか
 *
 * 変更量は**報告のみ**で、ゲートを止めるのは kill switch（`.loop-halt` /
 * `OPEN_RECEPTION_LOOP_HALT`）だけ。`collectStat` の結果は印字にしか使われない。
 * それでも欠陥の型は #709 / #712 と同じで、git の失敗を空文字へ落とすと
 * **`0 ファイル / 0 行` と印字され「変更していない」と読める**。
 * 「暴走に気づかない」方向の過小報告なので、測れなかったことは表に出す。
 *
 * ## なぜ一時リポジトリを使わないのか
 *
 * `change-budget.ts` の `tryGit` は **`cwd: ROOT`（リポジトリ root 固定）** で git を呼ぶ
 * （`scripts/change-budget.ts:29,33`）。他の検出器と違い cwd を継承しないので、一時
 * リポジトリを作っても対象は本リポジトリのままになる。**起点だけを明示的に固定**して、
 * 本リポジトリに対して走らせる。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, failingGitShim, TSX } from './helpers/git-repo';

const CLI = resolve(process.cwd(), 'scripts/change-budget.ts');

/** 起点は本リポジトリの HEAD に固定する（解決の揺れを持ち込まない）。 */
const HEAD_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

afterAll(cleanupTempDirs);

function run(shimDir?: string): { stdout: string; status: number } {
  const result = spawnSync(TSX, [CLI], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GATE_BASE_SHA: HEAD_SHA,
      ...(shimDir === undefined ? {} : { PATH: `${shimDir}:${process.env.PATH ?? ''}` }),
    },
  });
  return { stdout: result.stdout ?? '', status: result.status ?? -1 };
}

const NOTE = '集めきれていません';

describe('scripts/change-budget.ts: 測れなかったことを 0 件と言わない (#712)', () => {
  it('🔴 numstat が失敗したら、集めきれていないと出す', () => {
    const { stdout } = run(failingGitShim('diff'));
    expect(stdout).toContain(NOTE);
    expect(stdout).toContain('git diff --numstat');
  }, 60_000);

  it('🔴 未追跡ファイルの列挙が失敗したら、それも出す', () => {
    const { stdout } = run(failingGitShim('ls-files'));
    expect(stdout).toContain(NOTE);
    expect(stdout).toContain('ls-files');
  }, 60_000);

  it('正常に測れたときは但し書きを出さない（常態化させない）', () => {
    const { stdout } = run();
    expect(stdout).not.toContain(NOTE);
    expect(stdout).toContain('変更量:');
  }, 60_000);

  it('報告のみでゲートを止めない（kill switch は別）', () => {
    // 変更量は超えても FAIL させない。収集に失敗しても同じ（判定者ではない）。
    expect(run(failingGitShim('diff')).status).toBe(0);
  }, 60_000);
});
