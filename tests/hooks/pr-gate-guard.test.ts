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
 * 🔴 **判定方式を替えたので、前の方式が止めていた実行形を全部当て直す**
 * （`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら、前の方式が守っていた変異を
 * 当て直す」）。下の 2 つの配列が回帰行列そのもので、**散文ではなくこの配列が正本**である
 * （commit / docs に書いた件数が実測から遅れる型を避ける）。
 *
 * 🔴 **一覧は「自分が思いついた形」でしかない。** 初版は 18 形で「全部 kill」と報告したが、
 * 独立レビューが**族ごと 9 つ**（代入で運ぶ / `|&` / プロセス置換 / コマンド置換 / リダイレクト /
 * `fd -x` / `sort --compress-program` / `git -c core.pager` / `sed -i`）の見落としを出した。
 * 行列が全部 kill でも「穴が無い」とは言えない。
 */
const EXECUTION_FORMS: readonly [string, string][] = [
  ['直接実行', './scripts/merge-pull-request.ts 123'],
  ['npx tsx 経由', 'npx tsx scripts/merge-pull-request.ts 123'],
  ['npx tsx 経由（作成側）', 'npx tsx scripts/create-pull-request.ts --title x'],
  ['tsx 経由', 'tsx scripts/merge-pull-request.ts 123'],
  ['node 経由', 'node scripts/merge-pull-request.ts 123'],
  ['引用符付き（二重）', 'npx tsx "scripts/merge-pull-request.ts" 123'],
  ['引用符付き（単一）', "npx tsx 'scripts/merge-pull-request.ts' 123"],
  ['環境変数を前置', 'FOO=1 npx tsx scripts/merge-pull-request.ts 123'],
  ['変数へ代入して渡す', 'SCRIPT=scripts/merge-pull-request.ts; npx tsx $SCRIPT --number 997'],
  ['&& で連結', 'git push && npx tsx scripts/merge-pull-request.ts 123'],
  ['; で連結', 'git push; npx tsx scripts/create-pull-request.ts --fill'],
  ['サブシェル', '(npx tsx scripts/merge-pull-request.ts 123)'],
  ['グループ', '{ npx tsx scripts/merge-pull-request.ts 123; }'],
  ['バックグラウンド', 'npx tsx scripts/merge-pull-request.ts 123 &'],
  ['コマンド置換', 'echo $(npx tsx scripts/merge-pull-request.ts 123)'],
  ['gh pr merge', 'gh pr merge 1 --squash'],
  ['gh pr create', 'gh pr create --fill'],
  ['生の REST マージ', 'gh api repos/o/r/pulls/1/merge -X PUT'],
  ['xargs 経由（パイプ）', 'echo x | xargs -I{} gh pr create --fill'],
  ['xargs 経由（先頭）', 'xargs -I{} npx tsx scripts/merge-pull-request.ts'],
  ['time を前置', 'time npx tsx scripts/merge-pull-request.ts 123'],
  ['find -exec', 'find . -name x -exec npx tsx scripts/merge-pull-request.ts {} ;'],
  ['find -execdir', 'find . -name x -execdir npx tsx scripts/merge-pull-request.ts {} ;'],
  ['find -ok', 'find . -name x -ok npx tsx scripts/merge-pull-request.ts {} ;'],
  ['fd -x', 'fd -x npx tsx scripts/merge-pull-request.ts --number 997'],
  ['fd -X', 'fd -X npx tsx scripts/merge-pull-request.ts --number 997'],
  ['fd --exec', 'fd --exec npx tsx scripts/merge-pull-request.ts --number 997'],
  ['sort --compress-program', 'sort --compress-program=./scripts/merge-pull-request.ts a.txt'],
  ['git -c core.pager', 'git -c core.pager=./scripts/merge-pull-request.ts log'],
  ['sed -i（書き換え）', 'sed -i s/a/b/ scripts/merge-pull-request.ts'],
  ['読み取り→実行（&&）', 'grep -n x scripts/merge-pull-request.ts && npx tsx scripts/merge-pull-request.ts 1'],
  ['読み取り→実行（;）', 'cat README.md; gh pr merge 1 --squash'],
  ['読み取りの引数がコマンド置換', 'grep foo $(npx tsx scripts/create-pull-request.ts)'],
  ['読み取りの引数が backtick', 'grep -n x `npx tsx scripts/create-pull-request.ts`'],
  ['& で連結', 'grep -n x scripts/merge-pull-request.ts & npx tsx scripts/merge-pull-request.ts 1'],
  ['引用内の迂回宣言では迂回できない', 'echo "OPEN_RECEPTION_SKIP_GATE_GUARD=1" && gh pr merge 12'],
];

/**
 * 🔴 **読み取りを通した結果、実行の検出が弱くなっていないこと**（#960 の 4 番目の AC）。
 *
 * 読み取りコマンドは「引数として言及しただけ」だから通してよいのであって、その出力が
 * **実行系へ流れるなら話が別**である。パイプラインは**全段が読み取り専用のときだけ**落とす。
 * 段の連結は `|` だけではない ―― `|&`・プロセス置換・コマンド置換・backtick・リダイレクトも
 * 「読み取りの出力を実行へ渡す」綴りなので、同じ塊として扱う（レビューが 5 族を出した）。
 */
const READ_INTO_EXECUTOR: readonly [string, string][] = [
  ['パイプ', 'cat scripts/merge-pull-request.ts | bash'],
  ['|& パイプ', 'cat scripts/merge-pull-request.ts |& bash'],
  ['echo をシェルへ', 'echo npx tsx scripts/create-pull-request.ts --fill | sh'],
  ['プロセス置換', 'bash <(cat scripts/merge-pull-request.ts)'],
  ['プロセス置換（source）', 'source <(cat scripts/merge-pull-request.ts)'],
  ['コマンド置換', 'bash -c $(cat scripts/merge-pull-request.ts)'],
  ['リダイレクトで置く', 'cat scripts/merge-pull-request.ts > /tmp/m.ts'],
  ['tee で置く', 'cat scripts/merge-pull-request.ts | tee /tmp/m.ts'],
];

/** 何も実行しない読み取り形。ここが今回通るようになる本体。 */
const READ_FORMS: readonly string[] = [
  'grep -n delete scripts/merge-pull-request.ts',
  'grep -n delete scripts/merge-pull-request.ts | head -20',
  'rg -n delete scripts/merge-pull-request.ts',
  // 🔴 引用の中のメタ文字を素通しすると、ここが塊の境界として再解釈されて誤ブロックになる
  "rg -n 'create|merge' scripts/merge-pull-request.ts",
  "grep -E 'a|b' scripts/merge-pull-request.ts",
  "rg -n 'mergePr\\(' scripts/merge-pull-request.ts",
  "grep -n 'x;y' scripts/merge-pull-request.ts",
  'cat scripts/merge-pull-request.ts',
  'head -20 scripts/create-pull-request.ts',
  'sed -n 1,40p scripts/merge-pull-request.ts',
  'sed -n 1,40p scripts/merge-pull-request.ts | wc -l',
  'wc -l scripts/merge-pull-request.ts',
  'ls -la scripts/merge-pull-request.ts',
  // stderr のリダイレクトは日常的に打つ。標準出力のリダイレクトだけを実行側として見る
  'grep -n x scripts/merge-pull-request.ts 2>/dev/null',
  // 先頭の環境変数代入とフルパス起動を読み飛ばせているか（下界）
  'LC_ALL=C grep -n x scripts/merge-pull-request.ts',
  '/usr/bin/grep -n x scripts/merge-pull-request.ts',
  'git log --oneline -- scripts/merge-pull-request.ts',
  'git diff scripts/create-pull-request.ts',
  'git show HEAD:scripts/merge-pull-request.ts',
  'git -C . log --oneline -- scripts/create-pull-request.ts',
];

describe('pr-gate-guard: 読み取りは通し、実行は止める (#960)', () => {
  it.each(READ_FORMS)('読み取りコマンドの引数としての言及は通す: %s', (cmd) => {
    const { status, stderr } = runHook(cmd);
    expect(status, `${cmd}\n${stderr}`).toBe(0);
  });

  it.each(EXECUTION_FORMS)('🔴 実行形はブロックする（%s）', (_label, cmd) => {
    expect(runHook(cmd).status, cmd).toBe(2);
  });

  it.each(READ_INTO_EXECUTOR)('🔴 読み取りの出力が実行へ渡る形はブロックする（%s）', (_label, cmd) => {
    expect(runHook(cmd).status, cmd).toBe(2);
  });

  /**
   * 🔴 **道具の allowlist を静的に縛る。** 振る舞いの行列だけでは、allowlist へ
   * `xargs` を足す・`GIT_READ` へ `merge` を足すといった変異が**生存する**
   * （独立レビューの実測で 8/13 生存）。「入っていないこと」は下界なので、
   * 行列とは別に主張する必要がある。
   */
  it('🔴 読み取り allowlist に他プロセスを起動できる道具を入れない', () => {
    const hook = readFileSync(HOOK, 'utf8');
    const readList = /split\("([^"]*)", r, " "\)/.exec(hook)?.[1] ?? '';
    const gitList = /split\("([^"]*)", g, " "\)/.exec(hook)?.[1] ?? '';
    expect(readList, 'READ allowlist が読めない（実装の形が変わった）').not.toBe('');
    expect(gitList, 'GIT_READ allowlist が読めない').not.toBe('');

    // 他コマンドを起動できる／副作用を持つ道具は read 扱いにしない
    for (const forbidden of ['xargs', 'bash', 'sh', 'zsh', 'env', 'eval', 'exec', 'find', 'fd', 'sort', 'awk', 'node', 'npx', 'tsx', 'time']) {
      expect(readList.split(' '), `${forbidden} が読み取り扱いになっている`).not.toContain(forbidden);
    }
    for (const forbidden of ['merge', 'push', 'commit', 'rebase', 'reset', 'checkout', 'difftool']) {
      expect(gitList.split(' '), `git ${forbidden} が読み取り扱いになっている`).not.toContain(forbidden);
    }
  });

  /**
   * 🔴 **「他コマンドを起動するフラグ」の検査は、いまは振る舞いでは殺せない下界である。**
   * `find` / `fd` / `sort` を allowlist から外したので、`-exec` 族の検査を消しても
   * 行列は全部通る（実測で生存した）。だが allowlist へ道具を 1 つ足した瞬間に効き始める
   * 二重化なので、消えていないことを静的に縛る。
   */
  it('🔴 他コマンドを起動するフラグの検査が残っている', () => {
    const hook = readFileSync(HOOK, 'utf8');
    for (const flag of ['-exec', '-execdir', '-ok', '-okdir', '-x', '-X', 'exec-batch', 'compress-program']) {
      expect(hook, `${flag} の検査が消えている`).toContain(flag);
    }
  });

  /**
   * 🔴 **抽出に失敗したら deny 側へ倒す。** 判定パイプライン（perl / awk）が落ちたり
   * 道具が無かったりしたとき、空の scan を返すと**ガードが丸ごと無言で無効化**される。
   * 変更前は perl のみに依存していたので、awk を足した本変更は fail-open 面を 1 つ増やした
   * （独立レビューの指摘）。
   */
  it('🔴 判定に使う道具が落ちてもブロックする（fail-open にしない）', () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'broken-awk-'));
    try {
      // 判定パイプラインの最後段（awk）が失敗する環境を作る。実際に踏むのは
      // 「クラウドの素材が入っていない」形（gitleaks / semgrep / gh の欠落と同型）。
      writeFileSync(join(shimDir, 'awk'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const { status } = runHook('npx tsx scripts/merge-pull-request.ts 123', {
        env: { PATH: `${shimDir}:${process.env.PATH ?? ''}` },
      });
      expect(status, 'awk が落ちるとガードが素通りする（fail-open）').toBe(2);

      // 下界: 壊れた環境で「全部ブロック」に倒れているだけではないことも見る。
      // 生のコマンドへ落とすので、対象外のコマンドは従来どおり通る。
      expect(runHook('ls -la', { env: { PATH: `${shimDir}:${process.env.PATH ?? ''}` } }).status).toBe(0);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
