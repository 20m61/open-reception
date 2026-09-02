/**
 * `scripts/change-risk.ts` の振る舞い検証 (#709)。
 *
 * ## なぜ実走で縛るのか
 *
 * 判定そのものは純関数側（`src/domain/governance/change-risk.ts` /
 * `git-base.ts`）でユニットテスト済み。**危ないのは配線**で、スクリプトが
 * `measurement` を渡さなくなっても、判定保留の分岐を落としても、ドメインのテストは
 * 全部 green のままになる。そして落ちたときの症状が**沈黙**（「停止境界に触れていません」
 * と断定する）なので、気づく手立てが要る。#709 はまさにその形だった。
 *
 * ## なぜ一時リポジトリを作るのか
 *
 * 🔴 **このリポジトリ自身を対象にしない。** 最初そう書いたところ、起点に HEAD 自身を
 * pin していたため diff が常に空で、**「変更を実際に検出した実行」を一度も通っていなかった**
 * （#709 レビュー m-4）。作業ツリーの汚れ具合でも結果が変わる。
 * 入力を完全に制御できる一時リポジトリを作り、正常系・当たり・収集失敗を撃ち分ける。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// 🔴 **リネーム構築だけは共有ヘルパを使う** (#719 レビュー m-4)。
// 「起点コミットに移動元を入れる」という肝を 2 箇所に複製すると、片方だけ直したときに
// 素通りするテストへ戻る（今回まさに一度踏んだ型）。
import { makeRenameRepo } from './helpers/git-repo';

const CLI = resolve(process.cwd(), 'scripts/change-risk.ts');

/**
 * tsx は**リポジトリ root の絶対パス**で起動する。
 * `npx tsx` は cwd（＝検査対象の一時リポジトリ）の `node_modules` を見に行くので解決できない。
 */
const TSX = resolve(process.cwd(), 'node_modules/.bin/tsx');

/**
 * 本物の git の場所。**shim を置く前に控える**（shim が自分自身を呼ぶと無限再帰になる）。
 * `which` は POSIX 必須ではないので `command -v` を使う（他の hook テストと揃える）。
 */
const REAL_GIT = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();

/** 後始末する一時ディレクトリ。 */
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync(REAL_GIT, [...args], { cwd, encoding: 'utf8' });
}

function writeFile(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * 「起点コミット + そこからの変更 1 件」を持つリポジトリを作り、起点の sha を返す。
 *
 * `committed` はコミット済みの変更（= `git diff` でしか見えない）。#709 が落としていたのは
 * まさにこの系統なので、**必ずコミットしてから**検査させる。
 */
function makeRepo(
  committed: ReadonlyArray<string>,
  branch = 'main',
): { root: string; base: string } {
  const root = tempDir('change-risk-repo-');
  git(root, ['init', '--quiet', `--initial-branch=${branch}`]);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFile(root, 'README.md', 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  for (const path of committed) writeFile(root, path, 'export const x = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'change']);
  return { root, base };
}

/** `git diff` だけを失敗させる shim ディレクトリ。 */
function failingDiffShim(): string {
  const dir = tempDir('change-risk-shim-');
  const shim = join(dir, 'git');
  // `${REAL_GIT}` は空白を含みうるので必ず引用する。
  writeFileSync(
    shim,
    `#!/bin/bash\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then\n    echo "fatal: simulated failure" >&2\n    exit 128\n  fi\ndone\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

function run(
  repo: { root: string; base: string },
  options: { shimDir?: string; pinBase?: boolean } = {},
): { stdout: string; status: number } {
  const { shimDir, pinBase = true } = options;
  const env = { ...process.env };
  // **継承した GATE_BASE_SHA を持ち込まない。** ゲート実行中はこの変数が立っており、
  // 一時リポジトリには存在しない sha を指すので、起点の条件が揺れる。
  delete env.GATE_BASE_SHA;
  const result = spawnSync(TSX, [CLI], {
    cwd: repo.root,
    encoding: 'utf8',
    env: {
      ...env,
      ...(pinBase ? { GATE_BASE_SHA: repo.base } : {}),
      ...(shimDir === undefined ? {} : { PATH: `${shimDir}:${process.env.PATH ?? ''}` }),
    },
  });
  return { stdout: result.stdout ?? '', status: result.status ?? -1 };
}

const NO_BOUNDARY = '停止境界に触れていません';
const UNASSESSABLE = '判定はできていません';

describe('scripts/change-risk.ts: 測れていないことを断定しない (#709)', () => {
  it('🔴 git diff が失敗したら、触れていないと断定せず判定保留にする', () => {
    // これが #709 の本体。修正前は「変更ファイル: 0 件」＋「触れていません」と出ていた。
    const repo = makeRepo(['src/app/page.tsx']);
    const { stdout } = run(repo, { shimDir: failingDiffShim() });
    expect(stdout).not.toContain(NO_BOUNDARY);
    expect(stdout).toContain(UNASSESSABLE);
    // **何が測れなかったのかを名指しする**（「失敗した」だけでは直せない）。
    expect(stdout).toContain('git diff --name-only');
  }, 60_000);

  it('判定保留でも、集まった範囲の根拠と行動指示を落とさない', () => {
    // 保留にしたせいで当たりが消えると、修正前より情報が減る（レビュー m-1）。
    const repo = makeRepo(['infra/lib/stacks/web.ts']);
    // 未コミットにも置く（diff が死んでも status からは見える経路を作る）。
    writeFile(repo.root, 'infra/lib/stacks/api.ts', 'export const y = 1;\n');
    const { stdout } = run(repo, { shimDir: failingDiffShim() });
    expect(stdout).toContain(UNASSESSABLE);
    expect(stdout).toContain('本番デプロイ');
    expect(stdout).toContain('infra/lib/stacks/api.ts');
    expect(stdout).toContain('マージ前に確認する');
  }, 60_000);

  it('git が正常で当たりが無ければ「触れていません」と言い切る', () => {
    // **保留へ倒しすぎない。** 「判定保留の常態化」は過小報告と同じくらい危険（誰も読まなくなる）。
    // 断定してよい唯一の場合なので、ここは *出る* ことを固定する（レビュー m-4）。
    const repo = makeRepo(['src/app/page.tsx']);
    const { stdout } = run(repo);
    expect(stdout).toContain('変更ファイル: 1 件');
    expect(stdout).toContain(NO_BOUNDARY);
    expect(stdout).not.toContain(UNASSESSABLE);
  }, 60_000);

  it('起点を解決できなければ、当たりが無くても断定しない', () => {
    // `origin/main` も `main` も無いリポジトリ（起点解決が null になる）。
    // コミット済みの変更を丸ごと見落とすので、「触れていません」と言ってはいけない。
    const repo = makeRepo(['src/app/page.tsx'], 'work');
    const { stdout } = run(repo, { pinBase: false });
    expect(stdout).not.toContain(NO_BOUNDARY);
    expect(stdout).toContain(UNASSESSABLE);
    expect(stdout).toContain('起点を解決できない');
  }, 60_000);

  it('🔴 判定保留のときは専用の終了コード 3 で終わる (#713)', () => {
    // ゲートが「測れなかった」を **skip_unverified** として扱えるようにするための合図。
    // 出力の文言ではなく終了コードで伝えるのは、シェル側が文言に依存しないため。
    const repo = makeRepo(['src/app/page.tsx']);
    expect(run(repo, { shimDir: failingDiffShim() }).status).toBe(3);
  }, 60_000);

  it('判定できたときは、当たりの有無にかかわらず 0 で終わる (#713)', () => {
    // **保留へ倒しすぎない。** 検出器は report-only であって判定者ではないので、
    // 当たりがあってもゲートを止めない。
    expect(run(makeRepo(['src/app/page.tsx'])).status).toBe(0);
    expect(run(makeRepo(['infra/lib/stacks/web.ts'])).status).toBe(0);
  }, 60_000);

  it('🔴 非 ASCII 名のファイルでも停止境界を検出する (#718)', () => {
    // 既定の git は `"infra/lib/stacks/\\350\\252\\215\\350\\250\\274.ts"` と
    // エスケープして返すので `/^infra\\//` に一致せず、**「停止境界に触れていません」と
    // 報告していた**（実測）。停止境界の偽陰性なので、docs 判定の取りこぼしより筋が悪い。
    const repo = makeRepo(['infra/lib/stacks/認証.ts']);
    const { stdout } = run(repo);
    expect(stdout).toContain('人間承認が必要な変更に触れています');
    expect(stdout).toContain('infra/lib/stacks/認証.ts');
  }, 60_000);

  it('🔴 未コミットの非 ASCII でも停止境界を検出する（status 経路 / #718）', () => {
    // `makeRepo` は必ずコミットするので、コミット済みだけを見るテストは
    // **`git diff` 経路しか通らない**（`git status` 側の `-z` を外しても全部 green だった）。
    // ゲートは作業ツリーが dirty な状態で回るのが常態なので、実運用で支配的なのはこちら。
    const repo = makeRepo(['docs/既存.md']);
    writeFile(repo.root, 'infra/lib/stacks/認証.ts', 'export const x = 1;\n');
    const { stdout } = run(repo);
    expect(stdout).toContain('人間承認が必要な変更に触れています');
    expect(stdout).toContain('infra/lib/stacks/認証.ts');
  }, 60_000);

  describe('ガード対象からの持ち出しリネーム (#719)', () => {
    it.each([
      ['コミット済み（git diff 経路）', true],
      ['未コミット（git status 経路）', false],
    ])('🔴 %s: infra から docs へ動かしても停止境界として検出する', (_label, commit) => {
      // 新側しか見ないと `docs/移動.md` だけになり、**「停止境界に触れていません」**と
      // 報告していた（実測）。停止境界の偽陰性なので倒れる向きが安全側でない。
      const repo = makeRenameRepo('infra/lib/stacks/認証.ts', 'docs/移動.md', { commit });
      const { stdout } = run(repo);
      expect(stdout).toContain('人間承認が必要な変更に触れています');
      expect(stdout).toContain('infra/lib/stacks/認証.ts');
    }, 60_000);
  });

  it('git が正常で当たりがあれば、根拠パス付きで承認が要ると出す', () => {
    const repo = makeRepo(['infra/lib/stacks/web.ts']);
    const { stdout } = run(repo);
    expect(stdout).not.toContain(UNASSESSABLE);
    expect(stdout).toContain('人間承認が必要な変更に触れています');
    expect(stdout).toContain('infra/lib/stacks/web.ts');
  }, 60_000);
});
