/**
 * git の失敗を注入してスクリプトを実走させるためのハーネス (#712)。
 *
 * ## なぜ一時リポジトリを作るのか
 *
 * 🔴 **このリポジトリ自身を対象にしない。** 起点や作業ツリーの汚れ具合で結果が変わり、
 * 「変更を実際に検出した実行」を一度も通らないテストになりうる（#709 のレビューで
 * 実際に指摘された）。入力を完全に制御できる一時リポジトリを作る。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** cwd が別リポジトリになるので、tsx はリポジトリ root の絶対パスで起動する。 */
export const TSX = resolve(process.cwd(), 'node_modules/.bin/tsx');

/**
 * 本物の git の場所。**shim を置く前に控える**（shim が自分自身を呼ぶと無限再帰になる）。
 * `which` は POSIX 必須ではないので `command -v` を使う。**`-l`（ログインシェル）は
 * 使わない** —— プロファイルを読むので、バナーを出す環境ではパスにゴミが混じる。
 */
export const REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], {
  encoding: 'utf8',
}).trim();

const created: string[] = [];

/** `afterAll` から呼ぶ。作った一時ディレクトリを消す。 */
export function cleanupTempDirs(): void {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function git(cwd: string, args: ReadonlyArray<string>): string {
  // `git mv a b/c` は b が無いと失敗する。テスト側の意図は「移動」なので先に掘る。
  if (args[0] === 'mv' && args[2] !== undefined) {
    mkdirSync(dirname(join(cwd, args[2])), { recursive: true });
  }
  return execFileSync(REAL_GIT, [...args], { cwd, encoding: 'utf8' });
}

export function writeFile(root: string, relative: string, content = 'x\n'): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export type TempRepo = { root: string; base: string };

/**
 * 起点コミットの後にリネームを 1 件だけ入れたリポジトリを作る (#719)。
 *
 * `commit` が true ならリネームをコミットする（`git diff` 経路）。false なら未コミットの
 * まま残す（`git status` 経路）。**両方で効くことを確かめる**ため引数にしてある。
 */
export function makeRenameRepo(
  from: string,
  to: string,
  options: { commit: boolean },
  prefix = 'gate-rename-',
): TempRepo {
  // 🔴 **`from` は起点コミットに入れる。** 起点の後にコミットすると、起点から見た HEAD は
  // 「`to` が新規追加された」だけになり、**git はリネームとして報告しない**（実際に踏んだ）。
  // 検査したいのは「起点にあったものが持ち出された」ケースなので、この順序が要る。
  const root = tempDir(prefix);
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFile(root, from);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['mv', from, to]);
  if (options.commit) git(root, ['commit', '--quiet', '-m', 'rename']);
  return { root, base };
}

/**
 * 「起点コミット + `committed` をコミットした状態」のリポジトリを作る。
 *
 * `committed` は**コミット済み**なので `git diff` でしか見えない。収集失敗で落ちるのは
 * まさにこの系統なので、必ずコミットしてから検査させる。
 */
export function makeRepo(committed: ReadonlyArray<string>, prefix = 'gate-repo-'): TempRepo {
  const root = tempDir(prefix);
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFile(root, 'README.md', 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  for (const path of committed) writeFile(root, path);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'change']);
  return { root, base };
}

/**
 * 指定した git サブコマンドだけを失敗させる shim ディレクトリを作る。
 *
 * `REAL_GIT` はパスに空白を含みうるので必ず引用する。
 */
export function failingGitShim(subcommand: string): string {
  const dir = tempDir('gate-shim-');
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    `#!/bin/bash\nfor a in "$@"; do\n  if [ "$a" = "${subcommand}" ]; then\n    echo "fatal: simulated failure" >&2\n    exit 128\n  fi\ndone\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

export type RunOptions = {
  shimDir?: string;
  /** `GATE_BASE_SHA` を渡すか（既定 true）。false で起点解決の経路を通す。 */
  pinBase?: boolean;
  args?: ReadonlyArray<string>;
};

/** 一時リポジトリを cwd にしてスクリプトを実走させる。 */
export function runScript(
  cli: string,
  repo: TempRepo,
  options: RunOptions = {},
): { stdout: string; status: number } {
  const { shimDir, pinBase = true, args = [] } = options;
  const env = { ...process.env };
  // **継承した GATE_BASE_SHA を持ち込まない。** ゲート実行中はこの変数が立っており、
  // 一時リポジトリには存在しない sha を指すので起点の条件が揺れる。
  delete env.GATE_BASE_SHA;
  const result = spawnSync(TSX, [cli, ...args], {
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
