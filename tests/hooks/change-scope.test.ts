/**
 * `scripts/change-scope.ts` の振る舞い検証 (#712)。
 *
 * ## なぜ change-risk より重いのか
 *
 * `change-risk` は報告専用で何も止めないが、**`change-scope` は `docs` と判定すると
 * ゲートのステップを実際に飛ばす**（build / e2e / sast / lighthouse / vrm / infra）。
 * しかも `scripts/lib/gate-stamp.sh` の `gate_stamp_satisfies` はスタンプの **scope 列を
 * 読み捨てる**ので、`scope=docs` で書かれた green は `code` の green と区別なく
 * `pr-gate-guard.sh` のマージ判定を満たす。**未検証のツリーが green になる。**
 *
 * ## 全滅は安全側だが、部分失敗は安全側ではない
 *
 * `classifyChangeScope([])` が `code` を返すので、収集が**全部**失敗すれば安全側に倒れる。
 * 塞げていないのは**部分失敗**:
 *
 *   `git diff` だけ失敗（コミット済みのコード変更が消える）
 *     + 未コミットが docs のみ → paths は非空・docs のみ → `scope=docs` → 検証が飛ぶ
 *
 * #709 の修正コメントは「`change-scope` は同じ状況に既にガードを持っている」と書いたが、
 * それは**全滅ケースについてだけ**正しかった。
 */
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  failingGitShim,
  git,
  makeRenameRepo,
  makeRepo,
  runScript,
  writeFile,
  type TempRepo,
  type RunOptions,
} from './helpers/git-repo';

const CLI = resolve(process.cwd(), 'scripts/change-scope.ts');

afterAll(cleanupTempDirs);

const run = (repo: TempRepo, options: RunOptions = {}) => runScript(CLI, repo, options).stdout;
const failingDiffShim = () => failingGitShim('diff');

describe('scripts/change-scope.ts: 測れていないのに検証を省略しない (#712)', () => {
  it('文書だけの変更は docs と判定してステップを省略する（既存の契約）', () => {
    const stdout = run(makeRepo(['docs/note.md']));
    expect(stdout).toContain('scope=docs');
    expect(stdout).toContain('skip=build');
    expect(stdout).toContain('skip=e2e');
  }, 60_000);

  it('🔴 非 ASCII 名の文書だけの変更も docs と判定する (#718)', () => {
    // エスケープされると `/^docs\\//` に一致せず、文書だけ触った周回でも
    // build / e2e / lighthouse が毎回走っていた（倒れる向きは安全側だが、
    // 日本語主体のリポジトリでは「docs 判定は当てにならない」という不信になる）。
    const stdout = run(makeRepo(['docs/日本語メモ.md']));
    expect(stdout).toContain('scope=docs');
    expect(stdout).toContain('skip=build');
  }, 60_000);

  it('🔴 未コミットの非 ASCII 文書だけでも docs と判定する（status 経路 / #718）', () => {
    // `makeRepo` は必ずコミットするので、コミット済みだけを見るテストは `git diff` 経路
    // しか通らない。ゲートは作業ツリーが dirty な状態で回るのが常態。
    const repo = makeRepo(['docs/既存.md']);
    writeFile(repo.root, 'docs/未コミット日本語.md');
    const stdout = run(repo);
    expect(stdout).toContain('scope=docs');
    expect(stdout).toContain('skip=build');
  }, 60_000);

  it('コード変更があれば code で、何も省略しない', () => {
    const stdout = run(makeRepo(['src/app/page.tsx']));
    expect(stdout).toContain('scope=code');
    expect(stdout).not.toContain('skip=');
  }, 60_000);

  it('🔴 部分失敗（diff だけ失敗 + 未コミットが docs のみ）で docs に倒れない', () => {
    // これが #712 の本体。コミット済みのコード変更が diff の失敗で消え、
    // 残った未コミットが docs だけだと、修正前は scope=docs になって
    // build / e2e / sast / lighthouse が飛んだ。
    const repo = makeRepo(['src/app/page.tsx']);
    writeFile(repo.root, 'docs/note.md');
    const stdout = run(repo, { shimDir: failingDiffShim() });
    expect(stdout).toContain('scope=code');
    expect(stdout).not.toContain('skip=');
  }, 60_000);

  it('🔴 収集に失敗したことが出力に現れる（黙って安全側へ倒すだけにしない）', () => {
    // 「保留メッセージを見たことがない」＝「ガードが効いている」ではない。
    // 何が測れなかったのかが読めないと、効いているかどうかを確かめる術が無い。
    const repo = makeRepo(['src/app/page.tsx']);
    writeFile(repo.root, 'docs/note.md');
    const stdout = run(repo, { shimDir: failingDiffShim() });
    expect(stdout).toMatch(/^note=/m);
    expect(stdout).toContain('git diff --name-status');
  }, 60_000);

  describe('ガード対象からの持ち出しリネーム (#719)', () => {
    it.each([
      ['コミット済み（git diff 経路）', true],
      ['未コミット（git status 経路）', false],
    ])('🔴 %s: src → docs へ動かしたら docs と判定しない', (_label, commit) => {
      // 新側しか見ないと `docs/page.md` だけになり、**build / e2e / sast / lighthouse が
      // 飛んだまま green が記録される**（実測）。
      const repo = makeRenameRepo('src/app/page.tsx', 'docs/page.md', { commit });
      const stdout = run(repo);
      expect(stdout).toContain('scope=code');
      expect(stdout).not.toContain('skip=');
    }, 60_000);

    it.each([
      ['コミット済み', true],
      ['未コミット', false],
    ])('%s: docs 内のリネームは docs のままで、過剰に code へ倒れない', (_label, commit) => {
      // **倒しすぎない。** 持ち出しでないリネームまで code にすると、docs 判定が
      // 事実上死んで「当てにならない」という不信になる。
      const repo = makeRenameRepo('docs/古い.md', 'docs/新しい.md', { commit });
      const stdout = run(repo);
      expect(stdout).toContain('scope=docs');
      expect(stdout).toContain('skip=build');
    }, 60_000);
  });

  it('起点を解決できなければ code（既存のガードを壊さない）', () => {
    // 🔴 **未コミットに docs だけを置く。** クリーンなツリーだと収集結果が空になり、
    // ガードを外しても偶然 code のままで**テストが素通りする**（変異で実証）。
    // コミット済みのコード変更（起点が無いので見えない）＋ 未コミットの docs、
    // という「ガードが無ければ docs に倒れる」配置にする。
    const repo = makeRepo(['src/app/page.tsx']);
    writeFile(repo.root, 'docs/note.md');
    // origin/main も main も無い状態にする。
    git(repo.root, ['branch', '-m', 'main', 'work']);
    const stdout = run(repo, { pinBase: false });
    expect(stdout).toContain('scope=code');
    expect(stdout).not.toContain('skip=');
  }, 60_000);

  it('--strict では docs でも省略しない（既存の契約）', () => {
    const stdout = run(makeRepo(['docs/note.md']), { args: ['--strict'] });
    expect(stdout).toContain('scope=code');
    expect(stdout).not.toContain('skip=');
  }, 60_000);

  it('正常に測れたときは note を出さない（常態化させない）', () => {
    expect(run(makeRepo(['docs/note.md']))).not.toMatch(/^note=/m);
  }, 60_000);
});
