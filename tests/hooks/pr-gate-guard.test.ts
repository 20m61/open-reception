/**
 * `scripts/hooks/pr-gate-guard.sh` の振る舞い検証。
 *
 * このリポジトリは GitHub Actions を使わないため `./scripts/quality-gate.sh` が唯一の
 * ゲートだが、「PR 前必須」は規約上の自己申告に過ぎなかった。本フックは PreToolUse で
 * `gh pr create` / `gh pr merge` を捕まえ、**現在の作業ツリーに対する green なゲート実行の
 * 記録が無ければブロック**することで、規約を機械的な保証に変える。
 *
 * 検証は使い捨ての一時 git リポジトリを cwd にして実際にフックを起動する（スタンプは
 * その一時リポジトリの .git 配下に書かれるので、本リポジトリの状態を汚さない）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = resolve(process.cwd(), 'scripts/hooks/pr-gate-guard.sh');
const LIB = resolve(process.cwd(), 'scripts/lib/gate-stamp.sh');

let repo: string;

/** フックを起動し、終了コードと stderr を返す。 */
function runHook(
  command: string,
  opts: { tool?: string; env?: Record<string, string>; cwd?: string } = {},
): { status: number; stderr: string } {
  const payload = JSON.stringify({
    tool_name: opts.tool ?? 'Bash',
    tool_input: { command },
  });
  try {
    execFileSync('bash', [HOOK], {
      input: payload,
      cwd: opts.cwd ?? repo,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer };
    return { status: err.status ?? -1, stderr: err.stderr?.toString() ?? '' };
  }
}

/** 一時リポジトリの現在のツリー指紋を、フック本体と同じ実装で計算する。 */
function fingerprint(): string {
  return execFileSync('bash', ['-c', `source '${LIB}'; gate_tree_fingerprint`], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

/** 指定 tier / 指紋のスタンプを書き込む。 */
function writeStamp(tier: string, fp: string = fingerprint()): void {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(gitDir, 'open-reception-gate-stamp'), `${tier}\t${fp}\t2026-07-28T00:00Z\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-guard-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pr-gate-guard: 対象外は素通しする', () => {
  it('Bash 以外のツールには関与しない', () => {
    expect(runHook('gh pr create', { tool: 'Edit' }).status).toBe(0);
  });

  it('読み取り専用の gh pr サブコマンドは通す', () => {
    for (const cmd of ['gh pr view 1', 'gh pr list', 'gh pr diff 12', 'gh pr checks 3']) {
      expect(runHook(cmd).status, cmd).toBe(0);
    }
  });

  it('引用符の中の言及ではブロックしない', () => {
    // 🔴 fixture は引用の**中で** `gh` の前に空白がある形にする。`"gh pr ...` のように
    // 引用符が直前にあると、判定側の `(^|[;&|[:space:]])gh` に元から一致しないので、
    // 散文除去そのものを消す変異が生存する（独立レビューの実測）。
    expect(runHook('echo "see gh pr create later"').status).toBe(0);
  });

  it('heredoc 本文の言及ではブロックしない（コミットメッセージ等）', () => {
    // 実際に踏んだ誤検知: 本フック自身を説明するコミットメッセージが `gh pr merge` と
    // いう文字列を含み、git commit がブロックされた。ヒアドキュメントの中身はシェルの
    // コマンド位置ではないので、判定対象から外す。
    const cmd = [
      "git commit -q -F - <<'EOF'",
      'chore: フックを追加',
      '',
      'gh pr merge (要 --full) を捕まえてブロックする。',
      'gh pr create にも --pr 以上を要求する。',
      'EOF',
    ].join('\n');
    expect(runHook(cmd).status).toBe(0);
  });

  it('コマンド位置でない言及（コメント・散文）ではブロックしない', () => {
    expect(runHook('echo done  # gh pr create はゲートの後で').status).toBe(0);
    expect(runHook('rg -n "ゲート" docs/quality-gate.md').status).toBe(0);
  });

  it('コマンド位置の呼び出しは連結されていても捕まえる', () => {
    for (const cmd of [
      'git push -u origin HEAD && gh pr create --fill',
      'git push; gh pr create --fill',
      'echo x | xargs -I{} gh pr create --fill',
    ]) {
      expect(runHook(cmd).status, cmd).toBe(2);
    }
  });

  it('git リポジトリ外では判定できないので通す', () => {
    const outside = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(runHook('gh pr create', { cwd: outside }).status).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('pr-gate-guard: ゲート記録が無ければブロックする', () => {
  it('gh pr create をブロックし --pr を案内する', () => {
    const { status, stderr } = runHook('gh pr create --fill');
    expect(status).toBe(2);
    expect(stderr).toContain('--pr');
  });

  it('gh pr merge をブロックし --full を案内する', () => {
    const { status, stderr } = runHook('gh pr merge 12 --squash --delete-branch');
    expect(status).toBe(2);
    expect(stderr).toContain('--full');
  });

  // 🔴 **REST 経由の PR 作成もゲートの対象 (#678)。**
  // クラウドでは `gh pr create` が GraphQL 403 で使えないため、PR 作成は
  // `scripts/create-pull-request.ts` へ移した。ここを見ていないと、**移した先が
  // そのままゲートの抜け道になる** —— 開発をクラウドへ移した後は、そちらが主経路である。
  it('create-pull-request.ts をブロックし --pr を案内する', () => {
    const { status, stderr } = runHook('npx tsx scripts/create-pull-request.ts --head x --title y');
    expect(status).toBe(2);
    expect(stderr).toContain('--pr');
  });

  // 🔴 **マージも REST へ移った (#702)。** クラウドでは `gh pr merge` が GraphQL 403 に
  // なるため、マージの主経路は `scripts/merge-pull-request.ts` と生の
  // `gh api .../merge` である。ここを見ていないと **`--full` の green 記録が無いまま
  // マージできる** —— 作成側で #678 のときに塞いだのと同じ穴が、マージ側に開く。
  it('merge-pull-request.ts をブロックし --full を案内する', () => {
    const { status, stderr } = runHook('npx tsx scripts/merge-pull-request.ts --number 12');
    expect(status).toBe(2);
    expect(stderr).toContain('--full');
  });

  it('生の REST マージ（gh api .../merge -X PUT）もブロックする', () => {
    // スクリプトを経由せず直接叩く形が抜け道になってはいけない。
    const { status, stderr } = runHook(
      'gh api repos/20m61/open-reception/pulls/12/merge -X PUT -f merge_method=squash',
    );
    expect(status).toBe(2);
    expect(stderr).toContain('--full');
  });

  it('マージではない gh api 呼び出しは通す（誤検出はガードを無意味にする）', () => {
    // PR の照会は REST で日常的に行う。ここを止めると運用が回らない。
    expect(runHook('gh api repos/20m61/open-reception/pulls/12 --jq .merged').status).toBe(0);
    expect(runHook('gh api repos/20m61/open-reception/pulls?state=all').status).toBe(0);
  });
});

describe('pr-gate-guard: tier の充足を判定する', () => {
  it('--pr の記録があれば gh pr create を通す', () => {
    writeStamp('pr');
    expect(runHook('gh pr create --fill').status).toBe(0);
  });

  it('--full の記録は --pr の要求も満たす', () => {
    writeStamp('full');
    expect(runHook('gh pr create --fill').status).toBe(0);
  });

  it('--fast の記録では gh pr create を通さない', () => {
    writeStamp('fast');
    expect(runHook('gh pr create --fill').status).toBe(2);
  });

  it('--pr の記録では gh pr merge を通さない', () => {
    writeStamp('pr');
    const { status, stderr } = runHook('gh pr merge 12 --squash');
    expect(status).toBe(2);
    expect(stderr).toContain('--full');
  });

  it('--full の記録があれば gh pr merge を通す', () => {
    writeStamp('full');
    expect(runHook('gh pr merge 12 --squash --delete-branch').status).toBe(0);
  });
});

describe('pr-gate-guard: 記録が現在のツリーに対応しているかを見る', () => {
  it('別のツリーに対する記録（stale）はブロックする', () => {
    writeStamp('full', 'deadbeef'.repeat(8));
    const { status, stderr } = runHook('gh pr create --fill');
    expect(status).toBe(2);
    expect(stderr).toMatch(/stale|作業ツリー/);
  });

  it('ゲート後に追跡ファイルを編集したら記録は無効になる', () => {
    writeStamp('pr');
    writeFileSync(join(repo, 'a.txt'), 'edited after the gate\n');
    expect(runHook('gh pr create --fill').status).toBe(2);
  });

  it('ゲート後に未追跡ファイルを足したら記録は無効になる', () => {
    writeStamp('pr');
    writeFileSync(join(repo, 'new-source.ts'), 'export const x = 1;\n');
    expect(runHook('gh pr create --fill').status).toBe(2);
  });

  it('内容が同じならコミットしても記録は有効なまま（ゲート→コミット→PR が回る）', () => {
    // ループの実際の順序は「ゲート green → コミット → gh pr create」。指紋が HEAD に
    // 依存していると、コミットしただけで（中身は 1 文字も変わっていないのに）記録が
    // stale になり、ゲートの再実行を強いられる。指紋はツリーの**内容**で決める。
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    writeStamp('pr');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'feat: add feature'], { cwd: repo, stdio: 'ignore' });
    expect(runHook('gh pr create --fill').status).toBe(0);
  });

  it('非 ASCII 名のファイルの編集も検出する', () => {
    // git は既定 (core.quotePath=true) で非 ASCII パスを "..." にエスケープして出力する。
    // それをそのまま扱うとファイルが見つからず「削除済み」に分類され、**中身の変更を
    // 検出できない穴**になる。日本語ドキュメントを常用するリポジトリなので実際に踏み得る。
    const jp = join(repo, '設計メモ.md');
    writeFileSync(jp, '# 初版\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'docs: 追加'], { cwd: repo, stdio: 'ignore' });
    writeStamp('pr');
    expect(runHook('gh pr create --fill').status, 'ゲート直後は通る').toBe(0);

    writeFileSync(jp, '# 初版\n\nゲート後に書き足した。\n');
    expect(runHook('gh pr create --fill').status, '編集後は stale').toBe(2);
  });

  it('gitignore 済みのファイル（node_modules 等）は指紋に影響しない', () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: repo, stdio: 'ignore' });
    writeStamp('pr');
    execFileSync('mkdir', ['-p', join(repo, 'ignored')]);
    writeFileSync(join(repo, 'ignored', 'junk.txt'), 'noise\n');
    expect(runHook('gh pr create --fill').status).toBe(0);
  });
});

describe('pr-gate-guard: 明示的な脱出ハッチ', () => {
  it('フックの環境に OPEN_RECEPTION_SKIP_GATE_GUARD=1 があれば素通しできる', () => {
    const { status } = runHook('gh pr create --fill', {
      env: { OPEN_RECEPTION_SKIP_GATE_GUARD: '1' },
    });
    expect(status).toBe(0);
  });

  it('コマンド行に書いた OPEN_RECEPTION_SKIP_GATE_GUARD=1 でも素通しできる', () => {
    // フックは対象コマンドの**実行前に別プロセスとして**起動されるため、
    // `VAR=1 gh pr merge ...` のインライン代入はフック側の環境に届かない。
    // ドキュメントしている迂回方法はこの形なので、コマンド行そのものも見る。
    // 迂回がコマンドとして transcript に残るぶん、監査上もこちらの方が望ましい。
    expect(runHook('OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr create --fill').status).toBe(0);
    expect(runHook('OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr merge 12 --squash').status).toBe(0);
  });

  it('迂回の言及が引用符やヒアドキュメントの中だけなら素通しさせない', () => {
    const cmd = [
      "git commit -q -F - <<'EOF'",
      'docs: 迂回方法を書く',
      '',
      'OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr merge で迂回できる。',
      'EOF',
    ].join('\n');
    // heredoc 内なので gh pr merge 自体が判定対象外 → そもそもブロックされない
    expect(runHook(cmd).status).toBe(0);
    // 一方、実コマンドの gh pr merge を引用符内の言及だけで迂回はできない
    expect(runHook('echo "OPEN_RECEPTION_SKIP_GATE_GUARD=1" && gh pr merge 12').status).toBe(2);
  });
});

/**
 * #960: 読み取りコマンドの引数として現れただけではブロックしない。
 *
 * 由来: 2026-09-03、`grep -n delete scripts/merge-pull-request.ts | head -20` が
 * ブロックされた。grep は何もマージしないのに `--full` の green を要求され、事実確認に
 * 一手を余計に使った。誤発火が続くと `OPEN_RECEPTION_SKIP_GATE_GUARD=1` を習慣的に
 * 付けるようになる ―― 本リポジトリが繰り返し警告している「override の習慣化」そのもの。
 *
 * 🔴 **この行列は「方式を 2 度替えた」実績を持つ。**
 *
 * 最初の 2 版は「読み取りに見える塊を判定対象から落とす」blacklist だった。独立レビューが
 * 2 周にわたって抜け道を出し（`|&` / プロセス置換 / `&>` / `sed --in-place` /
 * `git grep -O` …）、**そのたびに綴りを 1 つ足す**形になった。3 版目で前提を替え、
 * 「シェルの機能を一切使わない読み取りパイプラインだけを通す」whitelist にした ――
 * 見落とした綴りが**常にブロック側へ倒れる**設計である。
 *
 * 4 版目（3 周目のレビュー後）で、**引用の扱いを正規表現から走査へ替えた**。
 * `cat "'" a.txt; gh pr merge 12 "'"` は、正規表現の対消しだと引用が
 * 「二重引用符の中の単引用符 2 つ」で対になり、**その間の `;` ごと消える**（変更前からの穴）。
 * 同時に、環境変数代入（`GIT_EXTERNAL_DIFF=<検出語> git diff` で**実際に起動した**）と
 * `sed`（`w` でファイルを書ける・GNU では `e` で起動できる）と
 * フルパス起動（`./bin/cat` で綴りを詐称できる）を whitelist から外した。
 *
 * 同じ入力を 7 版へ当てた実測（151 形）:
 *
 * | 版 | 実行しうる形 110 | 読み取り形 41 |
 * | --- | --- | --- |
 * | 変更前 `b9f9718` | 97 | 7 |
 * | blacklist 版 `6bba78b` | 62 | 38 |
 * | whitelist 版 `1616e8f` | 74 | 31 |
 * | 走査版 `04ebbc1` | 86 | 39 |
 * | 走査版 2 `84dd9c0` | 94 | 40 |
 * | 非解釈版 `f78735f` | 98 | 40 |
 * | 現在 | **110** | **41** |
 *
 * 🔴 **6 周のレビューで毎回「変更前が止めていた実行形が通る」が出た。** 原因はすべて
 * 「シェルを解釈しようとして bash とずれた」ことで、綴りを 1 つずつ足しても終わらなかった。
 * 6 版目で**解釈をやめ**（バックスラッシュ・`$`・backtick・波括弧・改行が現れたら
 * その時点で 2 段目へ落とす）、7 版目で**新しい機構を足すのをやめた** ――
 * リダイレクト先を食う処理が `;` ごと飲み込んで、日常的な
 * `npm run build >/tmp/b.log 2>&1;gh pr merge 997` を素通しにしていた。
 *
 * 🔴 **一覧は「自分が思いついた形」でしかない。** 各周とも「自分で当てた変異は全部 kill」と
 * 報告しており、**族ごとの見落としは独立レビューでしか出ていない**（9 族 → 4 族 → 3 族）。
 * 行列が全部 kill でも「穴が無い」とは言えない。
 *
 * 意図的に**通さない**読み取り（誤ブロックとして受け入れたもの。いずれも変更前と同じ挙動）:
 * `sed -n 1,40p <path>` / `/usr/bin/grep …`（フルパス起動）/ `… < /dev/null`（リダイレクト）/
 * `diff <(a) <(b)`（プロセス置換）。**穴を開けるより誤発火を残すほうが安い**。
 */
const EXECUTION_FORMS: readonly string[] = [
  "npx tsx scripts/merge-pull-request.ts 123",
  "npx tsx scripts/create-pull-request.ts --title x",
  "./scripts/merge-pull-request.ts 123",
  "tsx scripts/merge-pull-request.ts 123",
  "node scripts/merge-pull-request.ts 123",
  "npx tsx \"scripts/merge-pull-request.ts\" 123",
  "npx tsx 'scripts/merge-pull-request.ts' 123",
  "FOO=1 npx tsx scripts/merge-pull-request.ts 123",
  "SCRIPT=scripts/merge-pull-request.ts; npx tsx $SCRIPT --number 997",
  "git push && npx tsx scripts/merge-pull-request.ts 123",
  "git push; npx tsx scripts/create-pull-request.ts --fill",
  "(npx tsx scripts/merge-pull-request.ts 123)",
  "{ npx tsx scripts/merge-pull-request.ts 123; }",
  "npx tsx scripts/merge-pull-request.ts 123 &",
  "echo $(npx tsx scripts/merge-pull-request.ts 123)",
  "gh pr merge 1 --squash",
  "gh pr create --fill",
  "gh api repos/o/r/pulls/1/merge -X PUT",
  "echo x | xargs -I{} gh pr create --fill",
  "xargs -I{} npx tsx scripts/merge-pull-request.ts",
  "time npx tsx scripts/merge-pull-request.ts 123",
  "find . -name x -exec npx tsx scripts/merge-pull-request.ts {} ;",
  "find . -name x -execdir npx tsx scripts/merge-pull-request.ts {} ;",
  "find . -name x -ok npx tsx scripts/merge-pull-request.ts {} ;",
  "fd -x npx tsx scripts/merge-pull-request.ts --number 997",
  "fd -X npx tsx scripts/merge-pull-request.ts --number 997",
  "fd --exec npx tsx scripts/merge-pull-request.ts --number 997",
  "cat scripts/merge-pull-request.ts | bash",
  "cat scripts/merge-pull-request.ts |& bash",
  "echo npx tsx scripts/create-pull-request.ts --fill | sh",
  "bash <(cat scripts/merge-pull-request.ts)",
  "source <(cat scripts/merge-pull-request.ts)",
  "bash -c $(cat scripts/merge-pull-request.ts)",
  "cat scripts/merge-pull-request.ts > /tmp/m.ts",
  "cat scripts/merge-pull-request.ts | tee /tmp/m.ts",
  "sort --compress-program=./scripts/merge-pull-request.ts a.txt",
  "git -c core.pager=./scripts/merge-pull-request.ts log",
  "grep -n x scripts/merge-pull-request.ts && npx tsx scripts/merge-pull-request.ts 1",
  "cat README.md; gh pr merge 1 --squash",
  "grep foo $(npx tsx scripts/create-pull-request.ts)",
  "echo \"OPEN_RECEPTION_SKIP_GATE_GUARD=1\" && gh pr merge 12",
  "grep -n x `npx tsx scripts/create-pull-request.ts`",
  "grep -n x scripts/merge-pull-request.ts & npx tsx scripts/merge-pull-request.ts 1",
  "cat scripts/merge-pull-request.ts &> /tmp/m.ts",
  "cat scripts/merge-pull-request.ts &>> /tmp/m.ts",
  "cat scripts/merge-pull-request.ts 2>&1 > /tmp/m.ts",
  "cat scripts/merge-pull-request.ts 3>/tmp/m.ts",
  "cat scripts/merge-pull-request.ts & cat x > /tmp/m.ts",
  "git grep --open-files-in-pager=./scripts/merge-pull-request.ts x",
  "git show --output=/tmp/m.ts HEAD:scripts/merge-pull-request.ts",
  "bat --pager=./scripts/merge-pull-request.ts README.md",
  "git grep -O ./scripts/merge-pull-request.ts x",
  "git grep --open-files-in-pager ./scripts/merge-pull-request.ts x",
  "GIT_EXTERNAL_DIFF=./scripts/merge-pull-request.ts git diff",
  "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=./scripts/merge-pull-request.ts git diff",
  "PATH=./bin:/usr/bin cat scripts/merge-pull-request.ts",
  "RIPGREP_CONFIG_PATH=./cfg rg -n x scripts/merge-pull-request.ts",
  "GIT_SEQUENCE_EDITOR=./scripts/merge-pull-request.ts git status",
  "sed -n w /tmp/m.ts scripts/merge-pull-request.ts",
  "sed -n 1,40p scripts/merge-pull-request.ts",
  "./bin/cat scripts/merge-pull-request.ts",
  "/usr/bin/grep -n x scripts/merge-pull-request.ts",
  "rg --pre ./scripts/merge-pull-request.ts x .",
  "sed -i s/a/b/ scripts/merge-pull-request.ts",
  "sed --in-place s/a/b/ scripts/merge-pull-request.ts",
  "cat \"'\" a.txt; gh pr merge 12 --squash \"'\"",
  "grep \"don't\" a.txt; gh pr merge 1 --squash",
  "cat scripts/merge-pull-request.ts; gh pr merge 1",
  "sed e npx tsx scripts/merge-pull-request.ts 997 a.txt",
  "cat \"unclosed scripts/merge-pull-request.ts",
  "git grep -O./scripts/merge-pull-request.ts x",
  "rg --pre=./tool.sh -n x scripts/merge-pull-request.ts",
  "grep \"$(npx tsx scripts/create-pull-request.ts)\" a.txt",
  "grep \"`npx tsx scripts/create-pull-request.ts`\" a.txt",
  "cat a.txt#z; gh pr merge 12",
  "echo hi# ; npx tsx scripts/create-pull-request.ts",
  "git show HEAD --output /tmp/m.ts -- scripts/merge-pull-request.ts",
  "git log -p --output /tmp/m.ts -- scripts/merge-pull-request.ts",
  "git show HEAD --output=/tmp/m.ts -- scripts/merge-pull-request.ts",
  "git status --short\ngh pr merge 997 --squash --delete-branch",
  "git log --oneline -5\ngh pr create --fill",
  "ls -la\ngit push -u origin HEAD\nnpx tsx scripts/create-pull-request.ts --head x --title y",
  "rg -n foo src\ngh api repos/o/r/pulls/997/merge -X PUT",
  "cat scripts/merge-pull-request.ts \\",
  "uniq scripts/merge-pull-request.ts /tmp/m.ts",
  "git show HEAD:scripts/merge-pull-request.ts | uniq - /tmp/m.ts",
  "rg --pre ./scripts/merge-pull-request\\\n.ts x .",
  "git grep -O./scripts/merge-pull-request\\\n.ts x",
  "gh pr \\\n merge 12",
  "npx tsx scripts/merge-pull-request\\\n.ts 123",
  "echo \"$(gh pr merge 12)\"",
  "OUT=\"$(gh pr merge 12 --squash)\"",
  "echo \"`gh pr create --fill`\"",
  "gh pr merge 12 >/dev/null",
  "echo x >/tmp/y;gh pr merge 12 --squash",
  "npm run build >/tmp/b.log 2>&1;gh pr merge 997 --squash --delete-branch",
  "./scripts/quality-gate.sh --full >/tmp/gate.log;gh pr merge 997 --squash",
  "echo x >/tmp/y|gh pr merge 12",
  "wc -l </tmp/a.txt;gh pr create --fill",
  "LC_ALL=./scripts/merge-pull-request.ts git --config-env=diff.external=LC_ALL diff",
  "TZ=./scripts/create-pull-request.ts git --config-env=core.fsmonitor=TZ status",
  "git grep --open-files-in-pager=sh scripts/merge-pull-request.ts",
  "rg --pre=sh -n x scripts/merge-pull-request.ts",
  "git --exec-path=/tmp/x log -- scripts/merge-pull-request.ts",
  "LC_ALL=./scripts/merge-pull-request.ts grep -n x a.txt",
  "git --config-env=diff.external=LC_ALL log -- scripts/merge-pull-request.ts",
  "GIT_EXTERNAL_DIFF=sh grep -n x scripts/merge-pull-request.ts",
  "git add scripts/merge-pull-request.ts",
  "git checkout -- scripts/merge-pull-request.ts",
  "grep foo <<<Xbar\ngh pr merge 12 --squash\nXbar",
];

/** 何も実行しない読み取り形。ここが通るようになるのが #960 の本体。 */
const READ_FORMS: readonly string[] = [
  "grep -n delete scripts/merge-pull-request.ts",
  "rg -n delete scripts/merge-pull-request.ts",
  "rg -n 'create|merge' scripts/merge-pull-request.ts",
  "grep -E 'a|b' scripts/merge-pull-request.ts",
  "grep -n 'x;y' scripts/merge-pull-request.ts",
  "cat scripts/merge-pull-request.ts",
  "head -20 scripts/create-pull-request.ts",
  "wc -l scripts/merge-pull-request.ts",
  "git log --oneline -- scripts/merge-pull-request.ts",
  "git diff scripts/create-pull-request.ts",
  "git show HEAD:scripts/merge-pull-request.ts",
  "git -C . log --oneline -- scripts/create-pull-request.ts",
  "ls -la scripts/merge-pull-request.ts",
  "grep -n delete scripts/merge-pull-request.ts | head -20",
  "grep -n x scripts/merge-pull-request.ts 2>/dev/null",
  "LC_ALL=C grep -n x scripts/merge-pull-request.ts",
  "gh pr view 1",
  "gh api repos/o/r/pulls/1",
  "echo done  # gh pr create はゲートの後で",
  "ls -la",
  "OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr create --fill",
  "export OPEN_RECEPTION_SKIP_GATE_GUARD=1 && gh pr merge 1",
  "grep -x foo scripts/merge-pull-request.ts",
  "rg -x foo scripts/merge-pull-request.ts",
  "grep -v -x foo scripts/merge-pull-request.ts",
  "git log -p -- scripts/merge-pull-request.ts",
  "git blame scripts/merge-pull-request.ts",
  "git --no-pager log --oneline -- scripts/merge-pull-request.ts",
  "git log --oneline -- scripts/merge-pull-request.ts",
  "git diff --stat scripts/merge-pull-request.ts",
  "git diff --cached scripts/merge-pull-request.ts",
  "git log -p --follow scripts/merge-pull-request.ts",
  "cat --number scripts/merge-pull-request.ts",
  "head --lines=20 scripts/merge-pull-request.ts",
  "diff --unified scripts/merge-pull-request.ts scripts/create-pull-request.ts",
  "ls -la --color scripts/merge-pull-request.ts",
  "rg -n \"create|merge\" scripts/merge-pull-request.ts",
  "rg -o scripts/merge-pull-request.ts",
  "grep \"don't\" scripts/merge-pull-request.ts",
  "grep -n foo scripts/merge-pull-request.ts 2>&1",
  "git push && OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr merge 12 --squash",
];

/**
 * 🔴 **意図的に通さない読み取り。** #960 が消したかった痛み（誤発火）は残るが、
 * いずれも「解釈をやめる」ことと引き換えに得た安全側の判定であり、**変更前と同じ挙動**である。
 *
 * - バックスラッシュを含む形 … エスケープを解釈すると bash との差が必ず出る
 *   （行継続で語をつなぐ攻撃が実在した）。解釈しないので、含んでいたら 2 段目へ落とす
 * - `uniq` … 第 2 位置引数が**出力ファイル**になる（`uniq <検出語> /tmp/m.ts` で
 *   内容を書き出せる）。allowlist から外した
 * - 複数行・`sed`・フルパス起動・プロセス置換 … 同じ理由（解釈しない／書ける／詐称できる）
 *
 * **穴を開けるより誤発火を残すほうが安い。** ここを緩めたくなったら、まず
 * `docs/quality-gate.md` の 5 版比較表を読むこと。
 */
const DELIBERATELY_BLOCKED: readonly string[] = [
  "rg -n 'mergePr\\(' scripts/merge-pull-request.ts",
  "grep -n mergePr\\( scripts/merge-pull-request.ts",
  "cat scripts/merge-pull-request.ts | uniq | head",
  "cat scripts/merge-pull-request.ts\nwc -l scripts/create-pull-request.ts",
  "sed -n 1,40p scripts/merge-pull-request.ts",
  "/usr/bin/grep -n x scripts/merge-pull-request.ts",
  "diff <(cat scripts/merge-pull-request.ts) <(cat README.md)",
];

/**
 * 🔴 **変更前から通っている形（本 PR では塞がない）。**
 *
 * ここに並ぶのは「`b9f9718` から一貫して素通りしている」もので、**本 PR の退行ではない**。
 * 5 周目のレビューが `gh pr >/dev/null merge 12` を挙げたので 1 度は塞ぎにいったが、
 * そのために足したリダイレクト処理が `;` と次のコマンド名まで飲み込み、
 * `npm run build >/tmp/b.log 2>&1;gh pr merge 997` という**日常的な形**を素通しにした
 * （6 周目のレビュー。BLOCKER）。**新しい機構を足すほうが危ない**と判断して外し、
 * 元の穴は issue で追跡する。
 *
 * 通ることを**明示的に固定**しておく ―― 台帳が黙って伸びないように。塞いだらここを消す。
 * 追跡は #998（変更前から残る素通り 4 族）。
 */
const KNOWN_PRE_EXISTING_GAPS: readonly string[] = [
  "gh pr >/dev/null merge 12",
];

describe('pr-gate-guard: 読み取りは通し、実行は止める (#960)', () => {
  it.each(READ_FORMS)('読み取りは通す: %s', (cmd) => {
    const { status, stderr } = runHook(cmd);
    expect(status, `${cmd}\n${stderr}`).toBe(0);
  });

  it.each(EXECUTION_FORMS)('🔴 実行しうる形はブロックする: %s', (cmd) => {
    expect(runHook(cmd).status, cmd).toBe(2);
  });

  it.each(DELIBERATELY_BLOCKED)('意図的に通さない読み取り（誤発火として受け入れた形）: %s', (cmd) => {
    expect(runHook(cmd).status, cmd).toBe(2);
  });

  it.each(KNOWN_PRE_EXISTING_GAPS)('変更前から通っている形（本 PR の範囲外・issue で追跡）: %s', (cmd) => {
    expect(runHook(cmd).status, `${cmd}\n塞げたならこの配列から消すこと`).toBe(0);
  });

  /**
   * 🔴 **道具の allowlist を静的に縛る。** 振る舞いの行列だけでは、allowlist へ
   * `xargs` を足すといった変異が**生存する**（1 周目のレビューの実測で 13 変異中 8 生存）。
   * 「入っていないこと」は下界なので、行列とは別に主張する必要がある。
   *
   * 🔴 **コメントを外してから見る。** 実装のコメントには `--compress-program` のような
   * 語が説明として現れるので、コメント込みで探すと**検査が空虚に通る**（2 周目 m1）。
   */
  it('🔴 読み取り allowlist に他プロセスを起動できる道具を入れない', () => {
    const source = readFileSync(HOOK, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const readList = /my %READ = map \{ \$_ => 1 \} qw\(([^)]*)\)/.exec(source)?.[1] ?? '';
    const gitList = /my %GIT_READ = map \{ \$_ => 1 \} qw\(([^)]*)\)/.exec(source)?.[1] ?? '';
    const envList = /my %SAFE_ENV = map \{ \$_ => 1 \} qw\(([^)]*)\)/.exec(source)?.[1] ?? '';
    expect(readList.trim(), 'READ allowlist が読めない（実装の形が変わった）').not.toBe('');
    expect(gitList.trim(), 'GIT_READ allowlist が読めない').not.toBe('');
    expect(envList.trim(), 'SAFE_ENV allowlist が読めない').not.toBe('');

    const readTools = readList.split(/\s+/).filter(Boolean);
    for (const forbidden of ['xargs', 'bash', 'sh', 'zsh', 'env', 'eval', 'exec', 'find', 'fd', 'sort', 'awk', 'sed', 'less', 'more', 'node', 'npx', 'tsx', 'time', 'tee']) {
      expect(readTools, `${forbidden} が読み取り扱いになっている`).not.toContain(forbidden);
    }
    for (const forbidden of ['merge', 'push', 'commit', 'rebase', 'reset', 'checkout', 'difftool']) {
      expect(gitList.split(/\s+/).filter(Boolean), `git ${forbidden} が読み取り扱いになっている`).not.toContain(forbidden);
    }
    // 🔴 環境変数は「起動するものを差し替えられる」ので、無害な名前だけを許す
    // （`GIT_EXTERNAL_DIFF=<検出語> git diff` は実際にスクリプトを起動した）
    const envNames = envList.split(/\s+/).filter(Boolean);
    for (const name of envNames) {
      expect(name, `${name} は道具の振る舞いを変えうる`).toMatch(/^(LANG|LC_[A-Z]+|TZ)$/);
    }
  });

  /**
   * 🔴 **判定に使う道具が落ちたら deny 側へ倒す。** 空の判定結果を返すと、以降の grep が
   * 全部外れて**ガードが丸ごと無言で無効化**される（fail-open）。判定は perl / jq / tr に
   * 依存しているので全部について測る。**MCP 経路も一緒に見る** ―― 3 周目のレビューで、
   * jq が落ちたとき MCP だけ素通りしていた（2026-08-21 に main を red にした経路）。
   */
  it.each([['perl'], ['jq'], ['perl', 'jq']])('🔴 %s が落ちてもブロックする（fail-open にしない）', (...tools) => {
    const shimDir = mkdtempSync(join(tmpdir(), 'broken-tool-'));
    try {
      // 単独と両方の 3 通りを測る。判定は perl と jq にしか依存しない
      // （payload を読めない枝の記号潰しは bash の置換で行う ―― そこで `tr` を挟むと
      //  「道具が落ちている」経路に穴がもう 1 段増える。実測でそうなった）。
      for (const tool of tools) writeFileSync(join(shimDir, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const env = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };
      for (const cmd of ['npx tsx scripts/merge-pull-request.ts 123', 'gh pr merge 1 --squash']) {
        expect(runHook(cmd, { env }).status, `${tools.join('/')} が落ちると素通りする: ${cmd}`).toBe(2);
      }
      for (const mcp of ['mcp__github__merge_pull_request', 'mcp__github__create_pull_request']) {
        expect(runHook('', { tool: mcp, env }).status, `${tools.join('/')} が落ちると MCP が素通りする`).toBe(2);
      }
      // 下界: 壊れた環境で「全部ブロック」に倒れているだけではない
      expect(runHook('ls -la', { env }).status).toBe(0);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **道具の劣化は「全部落ちる」だけではない。** jq が成功して空を返す形・
   * `tool_name` は読めるが `command` は読めない形でも deny 側へ倒れること
   * （4 周目のレビューで、前者は素通り・後者は変異が生存していた）。
   */
  it.each([
    ['空を返す jq', '#!/bin/sh\nexit 0\n'],
    ['command だけ読めない jq', '#!/bin/sh\nfor a in "$@"; do case "$a" in *tool_input*) exit 1;; esac; done\nexec /usr/bin/jq "$@"\n'],
    ['command に空を返す jq', '#!/bin/sh\nfor a in "$@"; do case "$a" in *tool_input*) echo ""; exit 0;; esac; done\nexec /usr/bin/jq "$@"\n'],
    ['何もせず成功する perl', '#!/bin/sh\nexit 0\n'],
  ])('🔴 道具が %s でもブロックする', (_label, script) => {
    const shimDir = mkdtempSync(join(tmpdir(), 'degraded-tool-'));
    try {
      writeFileSync(join(shimDir, _label.includes('perl') ? 'perl' : 'jq'), script, { mode: 0o755 });
      const env = { PATH: `${shimDir}:${process.env.PATH ?? ''}` };
      expect(runHook('gh pr merge 1 --squash', { env }).status, 'Bash 経路が素通りする').toBe(2);
      expect(runHook('', { tool: 'mcp__github__merge_pull_request', env }).status, 'MCP 経路が素通りする').toBe(2);
      expect(runHook('ls -la', { env }).status).toBe(0);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });

  /** 脱出ハッチの `export` 形（1 周目 m1 で足したもの。消しても行列は気づかない）。 */
  it('export したインライン代入でも素通しできる', () => {
    expect(runHook('export OPEN_RECEPTION_SKIP_GATE_GUARD=1 && gh pr merge 12').status).toBe(0);
  });
});
