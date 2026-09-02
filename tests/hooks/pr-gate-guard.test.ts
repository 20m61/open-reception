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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(runHook('echo "gh pr create is required after the gate"').status).toBe(0);
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
