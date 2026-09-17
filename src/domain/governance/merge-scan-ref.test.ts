import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../tests/helpers/temp';
import {
  findUnexplainedMergeCommits,
  resolveMergeScanRef,
  type GitRunner,
} from '../../../scripts/check-merge-method';

/**
 * 検査の**対象**を固定する (#1031)。
 *
 * ## 何が起きていたか
 *
 * `findMergeCommitsSinceConvention()` は `HEAD` を走査していた。そのため
 * **feature ブランチで `git merge main` すると、その merge commit が規約違反として
 * 検出され**、unit が落ちて `--fast` / `--pr` / `--full` が全部赤くなった。
 * `pr-gate-guard.sh` が PR 作成もマージもブロックするので、**「main へ追随する」という
 * 日常の操作が、そのままループを止める**。2026-09-09 の PR #1017 で実際に踏んでいる。
 *
 * ## なぜ HEAD を見るのが誤りか
 *
 * 規約は「**main の履歴**が squash だけで出来ていること」である。feature ブランチの
 * merge commit は squash マージで**破棄され、main には決して届かない**。
 * HEAD を見るのは、測りたいもの（main の履歴）の代わりに別のもの（手元の作業履歴）を
 * 測っている ―― #1117 で撤回した `permissions.push` と同じ型である。
 *
 * ## 🔴 前の方式が守っていたものを落とさない
 *
 * この検査が入った直接のきっかけは #656 ―― **クラウドが `--squash` を使わず
 * merge commit で main へ入れた**という本物の欠陥である。対象を絞った結果
 * それを見逃すなら、直した意味が無い。下の「main 側の merge commit は検出する」が
 * その回帰で、**feature ブランチに立っていても検出できること**まで縛る。
 */

/** 後始末する一時ディレクトリ。 */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  // `git push` は進捗を stderr へ出す。ゲートのログへ混ぜない。
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** `cwd` に束縛した runner。失敗は `null`（ref が無い場合の扱いを実物で確かめる）。 */
function runnerFor(cwd: string): GitRunner {
  return (args) => {
    try {
      return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return null;
    }
  };
}

function commit(cwd: string, message: string): void {
  git(cwd, 'commit', '--allow-empty', '-m', message, '--no-gpg-sign');
}

/**
 * `origin`（bare）とその clone を作る。clone の `main` には squash 相当の単親コミットだけ。
 * `withMergeOnMain` が真なら、**main 自身へ merge commit を入れる**（#656 が捕まえた形）。
 */
function makeRepo(options: { withMergeOnMain?: boolean } = {}): string {
  const root = makeTempDir('merge-scan-');
  created.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'commit.gpgsign', 'false');
  commit(work, 'feat: 最初のコミット');
  commit(work, 'feat: 2 つ目');

  if (options.withMergeOnMain === true) {
    // main から枝を作り、**main 側へ merge commit として取り込む**（squash ではない）。
    git(work, 'checkout', '-b', 'side');
    commit(work, 'feat: 枝の作業');
    git(work, 'checkout', 'main');
    git(work, 'merge', '--no-ff', '--no-gpg-sign', '-m', "Merge branch 'side'", 'side');
  }
  git(work, 'push', '-u', 'origin', 'main');
  return work;
}

/** feature ブランチを作り、そこへ main を **merge** で取り込む（#1031 が踏んだ操作）。 */
function mergeMainIntoFeature(work: string): void {
  git(work, 'checkout', '-b', 'feat/x', 'main');
  commit(work, 'feat: 自分の作業');
  git(work, 'checkout', 'main');
  commit(work, 'feat: main が進む');
  git(work, 'push', 'origin', 'main');
  git(work, 'checkout', 'feat/x');
  git(work, 'merge', '--no-ff', '--no-gpg-sign', '-m', "Merge branch 'main' into feat/x", 'main');
}

describe('検査対象の ref (#1031)', () => {
  const IO_TIMEOUT = 30_000;

  it('origin/main があればそれを見る', () => {
    const work = makeRepo();
    expect(resolveMergeScanRef(runnerFor(work))).toBe('origin/main');
  }, IO_TIMEOUT);

  it('origin/main が無ければ main を見る', () => {
    const work = makeRepo();
    git(work, 'remote', 'remove', 'origin');
    expect(resolveMergeScanRef(runnerFor(work))).toBe('main');
  }, IO_TIMEOUT);

  /**
   * 🔴 **どちらも無ければ HEAD へ倒す（従来どおり）。** main が見えないなら main の履歴は
   * 判定できないが、**「見えないから違反なし」と読むより、見える範囲で落とす方が安全側**
   * （この検査の元の doc コメントと同じ判断）。
   */
  it('main 系の ref がどちらも無ければ HEAD へ倒す', () => {
    const work = makeRepo();
    git(work, 'remote', 'remove', 'origin');
    git(work, 'checkout', '-b', 'only-branch');
    git(work, 'branch', '-D', 'main');
    expect(resolveMergeScanRef(runnerFor(work))).toBe('HEAD');
  }, IO_TIMEOUT);
});

describe('feature ブランチの merge commit を規約違反にしない (#1031)', () => {
  const IO_TIMEOUT = 30_000;

  /** 🔴 これが本体。main を取り込んだだけでゲートが赤くなる状態を消す。 */
  it('feature ブランチで main を merge しても違反として出ない', () => {
    const work = makeRepo();
    mergeMainIntoFeature(work);
    // HEAD には merge commit が居る（前提の確認。居なければこのテストは空虚）。
    expect(git(work, 'log', '--merges', '--format=%s', 'HEAD')).toContain("Merge branch 'main'");
    expect(findUnexplainedMergeCommits(runnerFor(work))).toEqual([]);
  }, IO_TIMEOUT);

  /**
   * 🔴 **下界。** #656 が捕まえた本物の欠陥 ―― main 自身へ merge commit で入った形 ――
   * は、**feature ブランチに立っていても**検出できること。ここが落ちると、
   * 直した結果として検査が無力化されたことになる。
   */
  it('main 側の merge commit は、feature ブランチに立っていても検出する', () => {
    const work = makeRepo({ withMergeOnMain: true });
    mergeMainIntoFeature(work);
    const found = findUnexplainedMergeCommits(runnerFor(work));
    expect(found.map((c) => c.subject)).toContain("Merge branch 'side'");
    // feature ブランチ側の merge commit は**混ざらない**。
    expect(found.map((c) => c.subject)).not.toContain("Merge branch 'main' into feat/x");
  }, IO_TIMEOUT);

  it('main に merge commit が無ければ何も出ない', () => {
    const work = makeRepo();
    expect(findUnexplainedMergeCommits(runnerFor(work))).toEqual([]);
  }, IO_TIMEOUT);
});

describe('走査できなかったことを「違反なし」と読まない (#1031)', () => {
  /**
   * 🔴 **空集合と「測れなかった」を混ぜない。** git が落ちたときに `[]` を返すと、
   * 検査は緑のまま通る ―― このリポジトリが繰り返し禁じている型
   * （`branch_check_unverified` / `command-preflight` と同じ）。
   */
  it('git が失敗したら例外にする', () => {
    const brokenRunner: GitRunner = (args) => (args[0] === 'rev-parse' ? '' : null);
    expect(() => findUnexplainedMergeCommits(brokenRunner)).toThrow();
  });

  /** 下界。走査が成功していれば当然 throw しない。 */
  it('走査できていれば throw しない', () => {
    const okRunner: GitRunner = () => '';
    expect(() => findUnexplainedMergeCommits(okRunner)).not.toThrow();
  });
});
