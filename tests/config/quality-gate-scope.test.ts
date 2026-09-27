/**
 * 変更範囲による省略の**シェル側**の配線 (#712)。
 *
 * ## なぜ要るか
 *
 * 判定は `src/domain/governance/change-scope.ts`（純関数）と `scripts/change-scope.ts`
 * （`tests/hooks/change-scope.test.ts` が実走で固定）にある。**残る危険は配線**で、
 * `quality-gate.sh` が出力をどう読むかが誰にも縛られていなかった。
 *
 * #709 / #712 が繰り返し踏んでいるのがまさにこれ ——「判定は正しいのに、それが機械へ
 * 伝わる経路が黙って落ちる」。落ちたときの症状は**検証を飛ばしたまま green**。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../helpers/temp';

const REPO = process.cwd();

/**
 * scripts/ だけを持つ一時 git リポジトリでゲートを動かし、change-scope の出力を差し替える。
 *
 * `exitCode` を非 0 にすると、`quality-gate.sh` のフォールバック（`|| echo "scope=code"`）が
 * **後から**流れる状況を作れる。
 */
function runGate(options: {
  scopeOutput: string;
  exitCode?: number;
  withBase?: boolean;
  /** 🔴 AC4 の**正の対照**用。false にすると `gate-tooling.sh` を持ち込まない。 */
  withTooling?: boolean;
}): {
  status: number;
  stdout: string;
  stderr: string;
  stamp: string;
} {
  const dir = makeTempDir('gate-scope-');
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  cpSync(resolve(REPO, 'scripts/quality-gate.sh'), join(dir, 'scripts/quality-gate.sh'));
  // 🔴 **`gate-tooling.sh` も持っていく (#1136 AC4)。** 無いと temp 側の
  //    `quality-gate.sh` が毎回 `No such file or directory` を stderr へ出し、
  //    「どのテストが落ちたか分からない FAIL」の読み解きを難しくする（実測で 19 行）。
  if (options.withTooling !== false) {
    cpSync(resolve(REPO, 'scripts/lib/gate-tooling.sh'), join(dir, 'scripts/lib/gate-tooling.sh'));
  }
  cpSync(resolve(REPO, 'scripts/lib/gate-stamp.sh'), join(dir, 'scripts/lib/gate-stamp.sh'));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  // 🔴 **既定では起点が解決できる状態にする。** コミットが無いと `merge-base` が失敗し、
  // ゲートは「変更範囲を測れていない」と判断する（#717）。それは正しい挙動なので、
  // 「測れた」経路を検査したいテストは起点を用意しなければならない。
  if (options.withBase !== false) {
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
  }

  writeFileSync(
    join(dir, 'bin', 'npx'),
    `#!/usr/bin/env bash
case "$*" in
  *--version*) exit 0 ;;
  *" -e "*) printf ''; exit 0 ;;
  *change-scope.ts*) printf '%b\\n' ${JSON.stringify(options.scopeOutput)}; exit ${options.exitCode ?? 0} ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'bin', 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  // 🔴 **`spawnSync` で取る（レビュー 2 周目 MAJOR 1）。**
  //
  // 以前は `execFileSync` ＋ `stdio: ['ignore','pipe','pipe']` で、成功パスの `stderr` を
  // **どこにも入れていなかった**（`execFileSync` の戻り値は stdout だけ。実測で確認）。
  // つまり `not.toContain('gate-tooling.sh: No such file')` は**常に空虚に通っていた** ——
  // `cpSync` の 1 行を消しても 9 passed で、1 周目の指摘に対して kill が 1 つも増えて
  // いなかった。さらに悪いことに、`stdio` を pipe へ変えたことで child の stderr が
  // **画面からも消え**、AC4 が消そうとした騒音を「直したから消えた」のか
  // 「捕まえて捨てたから消えた」のか区別できなくしていた（沈黙の誤動作への変換）。
  const proc = spawnSync(join(dir, 'scripts/quality-gate.sh'), ['--pr', '--no-bootstrap'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` },
  });
  const status = proc.status ?? -1;
  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const stampPath = join(dir, '.git', 'open-reception-gate-stamp');
  return { status, stdout, stderr, stamp: existsSync(stampPath) ? readFileSync(stampPath, 'utf8') : '' };
}

/**
 * 🔴 **既定の 5s では足りない（弱体化ではない）。**
 *
 * ここの各ケースは `git init` と `quality-gate.sh` の**子プロセス**を実走する。
 * 単独実行なら 1〜2s で終わるが、`npm test` の 500 ファイル並行実行の中では
 * CPU 待ちだけで 5s を超え、**アサーションに到達する前に**
 * `Test timed out in 5000ms` で落ちる（2026-08-20 に本ファイル・
 * `quality-gate-stamp.test.ts` の各先頭ケースで観測。単独実行では全 PASS）。
 *
 * `tests/hooks/aws-*.test.ts` が同じ理由で採っている扱いに揃える。
 * **同じアサーションに、到達するまでの時間を与えるだけ**で、実際に壊れているものは
 * 30s あっても落ちる。
 */
vi.setConfig({ testTimeout: 30_000 });

describe('quality-gate: 変更範囲の読み取り配線 (#712)', () => {
  /**
   * 🔴 **AC4 の下界（#1136 レビュー 1 周目 MINOR 3）。**
   *
   * temp ツリーへ `scripts/lib/gate-tooling.sh` を持ち込む変更を入れたが、
   * **それを縛るものが何も無かった** —— 実測で `cpSync` を 1 行消しても 8 passed。
   * 「stderr 19 行 → 0 行」は測ったのに回帰では守られていなかったので、
   * 撤回が沈黙する。ここで倒れ方を見る。
   */
  it('🔴 temp ツリーの gate は gate-tooling.sh を見つけられる（stderr が黙る）', () => {
    const r = runGate({ scopeOutput: '{"total":1,"files":["src/a.ts"]}' });
    expect(r.stderr).not.toContain('gate-tooling.sh: No such file');
    // 下界 1: gate を実際に起動できたこと（起動できていなければ stderr は空で空虚に通る）。
    expect(r.stdout).toContain('quality-gate');
  }, 30_000);

  /**
   * 🔴 **正の対照（レビュー 2 周目 MAJOR 1）。**
   *
   * 「出ない」だけを主張するテストは、**stderr を一度も観測していない世界でも通る**
   * ——実際に通っていた。持ち込まなければ**検出されること**を併せて縛る。
   * これが在ると、`stderr` の配線を落とす変異も倒れる。
   */
  it('🔴 gate-tooling.sh を持ち込まなければ、その stderr が実際に観測される', () => {
    const r = runGate({ scopeOutput: '{"total":1,"files":["src/a.ts"]}', withTooling: false });
    expect(r.stderr).toContain('gate-tooling.sh');
    expect(r.stderr).toContain('No such file');
  }, 30_000);

  it('docs 判定なら省略する（既存の契約）', () => {
    const { stdout } = runGate({ scopeOutput: 'scope=docs\nskip=build' });
    expect(stdout).toContain('SKIP  build (next build)');
  });

  it('🔴 判定が code に倒れたら、直前に読んだ skip を引きずらない', () => {
    // `change-scope.ts` が scope=docs と skip=build を印字した**後**に死ぬと、
    // フォールバックの `echo "scope=code"` が後から流れて GATE_SCOPE は code に戻る。
    // このとき GATE_SKIPS が残っていると「code なのに build を省略した」まま green になる
    // ——#712 が塞ごうとした被害（未検証ツリーが green）とまったく同じ。
    const { stdout } = runGate({ scopeOutput: 'scope=docs\nskip=build\nskip=e2e', exitCode: 1 });
    expect(stdout).not.toContain('SKIP  build (next build)');
    expect(stdout).not.toContain('code-scope');
  });

  it('🔴 note= を読み取ってゲート出力に見せる', () => {
    // 「測れなかったので省略しなかった」は scope=code なので、ここで拾わないと
    // **完全に不可視**になる（code のときシェルは change-scope のブロックを出さない）。
    const { stdout } = runGate({ scopeOutput: 'scope=code\nnote=収集に失敗しました' });
    expect(stdout).toContain('判定の但し書き');
    expect(stdout).toContain('収集に失敗しました');
  });

  it('🔴 note があれば summary にも残す（10 分後まで届かせる / #717）', () => {
    // `--full` は 10 分以上走り、この ⚠ は先頭付近に出て**末尾のサマリからは消える**。
    // `scope_skip` は「省略した理由をサマリへ残す」方針なのに、「測れなかった」側だけ
    // 非対称に扱われていた。
    const { stdout } = runGate({ scopeOutput: 'scope=code\nnote=収集に失敗しました' });
    expect(stdout).toMatch(/^ {2}NOTE {2}change-scope/m);
    expect(stdout).toContain('収集に失敗しました');
  });

  it('🔴 測れなかった実行はスタンプの scope 列にも残る (#717)', () => {
    // クラウドは浅い clone。恒常的に起きていても**後から数える手段が無い**のが問題。
    const { stamp } = runGate({ scopeOutput: 'scope=code\nnote=収集に失敗しました' });
    expect(stamp).toContain('code(unmeasured)');
  });

  it('測れた実行の scope 列は従来どおり（常態化させない）', () => {
    expect(runGate({ scopeOutput: 'scope=docs\nskip=build' }).stamp).toMatch(/\tdocs\n?$/);
  });

  it('🔴 起点を解決できない実行も「測れなかった」として記録する (#717)', () => {
    // クラウドは浅い clone なので**本命はこの経路**。ここを数えないと、
    // カウンタが 0 のことが「測れている」証拠として読まれる（偽の安心）。
    // 表示は起点解決の節で済んでいるので、⚠ は二重に出さない。
    const r = runGate({ scopeOutput: 'scope=code', withBase: false });
    expect(r.stdout).toMatch(/^ {2}NOTE {2}change-scope {2}\(共通祖先/m);
    expect(r.stamp).toContain('(unmeasured)');
  });

  it('note が無ければ但し書きの節を出さない（常態化させない）', () => {
    const { stdout } = runGate({ scopeOutput: 'scope=code' });
    expect(stdout).not.toContain('判定の但し書き');
  });
});
