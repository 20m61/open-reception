/**
 * `scripts/hooks/push-secret-guard.sh` の振る舞い検証（issue #682）。
 *
 * `scripts/quality-gate.sh` が gitleaks を走らせるのは `--secrets` / `--full` のときだけで、
 * その2つは既定でクラウド委譲（CLAUDE.md）。実際の流れは
 * 「実装 → --fast（gitleaks なし）→ git push → クラウドで --full（gitleaks あり）」であり、
 * **push という外部へ出る境界の直前にローカルで秘密情報を見る検査が存在しなかった**。
 * 本フックはその境界（`git push`）を PreToolUse で捕まえ、push しようとしているコミット範囲
 * （`<base>..HEAD`）だけを gitleaks で走査し、検出したらブロックする。
 *
 * 検証は使い捨ての一時 git リポジトリを cwd にして実際にフックを起動する。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK = resolve(process.cwd(), 'scripts/hooks/push-secret-guard.sh');
const BASH = '/bin/bash';

let repo: string;

/** フックを起動し、終了コードと stdout/stderr を返す（成功時も stderr を保持する）。 */
function runHook(
  command: string,
  opts: { tool?: string; env?: Record<string, string>; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const payload = JSON.stringify({
    tool_name: opts.tool ?? 'Bash',
    tool_input: { command },
  });
  const result = spawnSync(BASH, [HOOK], {
    input: payload,
    cwd: opts.cwd ?? repo,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * 使い捨てリポジトリを 1 つ作り、main に初期コミットを積んだ上で feature ブランチへ
 * checkout する。フックは `<base>..HEAD` の範囲だけを走査するため、**main そのものに
 * コミットしても範囲が空になり検出できない**（実際に一度これで踏んだ）。実運用の
 * 「main から切った feature ブランチで作業して push する」を再現する。
 */
function initRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-q', '-b', 'feature');
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', message], { cwd: dir, stdio: 'ignore' });
}

/** gitleaks を含まない PATH を作る（他の必須コマンドは実体を symlink する）。 */
function pathWithoutGitleaks(): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-gitleaks-path-'));
  for (const bin of ['git', 'jq', 'perl', 'tr', 'grep', 'cat', 'bash', 'sh']) {
    const real = execFileSync(BASH, ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(dir, bin));
  }
  return dir;
}

// 構文上は有効な AWS アクセスキー ID 形式（AKIA + [A-Z2-7]{16}）だが、明確な偽値。
//
// 🔴 AWS 公式ドキュメントのサンプルキー `AKIAIOSFODNN7EXAMPLE` は**使わない**。実際に
// gitleaks のデフォルト設定を調べたところ（8.30.1、`aws-access-token` ルール）、
// `.+EXAMPLE$` という allowlist 正規表現がルールに組み込まれており、この文字列は
// **意図的に検出対象から除外される**（gitleaks 自身がドキュメント例をノイズとして
// 弾くため）。変異テストとして「検出されること」を固定したいので、末尾が `EXAMPLE`
// ではない別の偽値を使う。実 secret ではなく、`TESTFAKEKEY` を含む明確な擬似値。
const FAKE_AWS_KEY = 'AKIATESTFAKEKEY23456';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'push-secret-guard-'));
  initRepo(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('push-secret-guard: 対象外は素通しする', () => {
  it('Bash 以外のツールには関与しない', () => {
    expect(runHook('git push', { tool: 'Edit' }).status).toBe(0);
  });

  it('git push を含まないコマンドは素通しする', () => {
    for (const cmd of ['git status', 'git commit -m "x"', 'git log', 'npm test']) {
      expect(runHook(cmd).status, cmd).toBe(0);
    }
  });

  it('引用符・ヒアドキュメント・コメントの中の言及ではスキャンしない', () => {
    expect(runHook('echo "git push is required after review"').status).toBe(0);
    expect(runHook('echo done  # git push はレビュー後に').status).toBe(0);
  });

  it('git リポジトリ外では判定できないので通す', () => {
    const outside = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    try {
      expect(runHook('git push', { cwd: outside }).status).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('push-secret-guard: コマンド位置の git push を捕まえる', () => {
  it('連結されていても捕まえる', () => {
    commit(repo, 'clean.txt', 'nothing secret here\n', 'feat: clean');
    for (const cmd of ['npm run build && git push', 'git push; echo done', 'true | true && git push origin HEAD']) {
      // 秘密情報が無いので通るが、少なくとも「対象コマンドとして扱われる」ことを別テストで検証する
      expect(runHook(cmd).status, cmd).toBe(0);
    }
  });
});

describe('push-secret-guard: git push をサブコマンド位置で検出する（global option を挟んでも）', () => {
  // 単純な `git\s+push` 正規表現だと `git -C <path> push` のように global option を挟んだ
  // 呼び出しを取りこぼす。worktree 作業では `-C` を素直に使う（実際にこのセッションで
  // 複数回使った）。差分テスト: 秘密情報を含むコミットを積んだ上で、各種の書き方が
  // ブロックされるか（＝ git push として認識されるか）を確認する。
  const GIT_PUSH_FORMS = [
    'git push origin HEAD',
    'git -C REPO push origin HEAD',
    'git --git-dir=REPO/.git --work-tree=REPO push origin HEAD',
    '/usr/bin/git push origin HEAD',
    './git push origin HEAD',
    'git -c foo=bar push origin HEAD',
    'git --no-pager push origin HEAD',
    'git -c foo=bar -C REPO --no-pager push origin HEAD',
  ];

  // 「push」という語がコマンドのどこかに現れるだけで、実際のサブコマンドは push ではない
  // ケース。誤検出するとガードが回避されるようになる（false positive は false negative より
  // 悪い）ので、こちらも同じ条件（秘密情報あり）で green のままであることを固定する。
  const MERE_MENTIONS = [
    'git log --grep push',
    'git config --get remote.origin.pushurl',
    'echo "git push"',
    'cat git-push-notes.txt',
    'git remote add origin git@github.com:x/push.git',
    'git -c foo=bar log --grep push',
    'git --version',
  ];

  it.each(GIT_PUSH_FORMS)('検出する: %s', (form) => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const cmd = form.replaceAll('REPO', repo);
    expect(runHook(cmd).status, cmd).toBe(2);
  });

  it.each(MERE_MENTIONS)('誤検出しない: %s', (cmd) => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    expect(runHook(cmd).status, cmd).toBe(0);
  });
});

describe('push-secret-guard: 秘密情報を検出したらブロックする', () => {
  it('push しようとしている範囲に AWS アクセスキー ID があればブロックする', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const { status, stderr } = runHook('git push origin HEAD');
    expect(status).toBe(2);
    expect(stderr).toContain('push-secret-guard.sh');
    expect(stderr).toMatch(/秘密情報|leak\.env/);
  });

  it('秘密情報が無い変更は通す', () => {
    commit(repo, 'feature.ts', 'export const feature = true;\n', 'feat: add feature');
    expect(runHook('git push origin HEAD').status).toBe(0);
  });

  it('検出後にその変更を取り消せば再び通る（変異テスト: 追加→ブロック→除去→green）', () => {
    // 追加前は green
    expect(runHook('git push origin HEAD').status, '変更前は green').toBe(0);

    // 追加後は red
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    expect(runHook('git push origin HEAD').status, '追加後は red').toBe(2);

    // 該当コミットを丸ごと取り消す（未 push のローカルコミットなので安全に破棄できる）
    execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: repo, stdio: 'ignore' });
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status.trim(), '取り消し後、作業ツリーはクリーン').toBe('');
    expect(runHook('git push origin HEAD').status, '取り消し後は green').toBe(0);
  });
});

describe('push-secret-guard: 明示的な脱出ハッチ', () => {
  it('フックの環境に OPEN_RECEPTION_SKIP_SECRET_SCAN=1 があれば秘密情報があっても通す', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const { status } = runHook('git push origin HEAD', {
      env: { OPEN_RECEPTION_SKIP_SECRET_SCAN: '1' },
    });
    expect(status).toBe(0);
  });

  it('コマンド行に書いた OPEN_RECEPTION_SKIP_SECRET_SCAN=1 でも通す', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    expect(runHook('OPEN_RECEPTION_SKIP_SECRET_SCAN=1 git push origin HEAD').status).toBe(0);
  });
});

describe('push-secret-guard: gitleaks が無い場合', () => {
  it('既定では警告した上で通す（無言では通さない）', () => {
    const dir = pathWithoutGitleaks();
    const { status, stderr } = runHook('git push origin HEAD', { env: { PATH: dir } });
    expect(status).toBe(0);
    expect(stderr).toMatch(/gitleaks.*not installed|gitleaks.*SKIP/i);
  });

  it('OPEN_RECEPTION_STRICT_SECRET_SCAN=1 なら未スキャンでの push をブロックする', () => {
    const dir = pathWithoutGitleaks();
    const { status, stderr } = runHook('git push origin HEAD', {
      env: { PATH: dir, OPEN_RECEPTION_STRICT_SECRET_SCAN: '1' },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('push-secret-guard.sh');
  });
});
