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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 **既定の 5 秒では足りない。**
 *
 * 各ケースは使い捨ての git リポジトリを作り（`git init` / `add` / `commit` を複数回）、
 * そのうえで bash のフックを起動し、フックの中で **gitleaks が差分を走査**する。
 * 単独実行でも 31 ケースで 17 秒かかる（実測）。ゲートの unit ステップは 557 ファイルを
 * 並列で回すので、その下では 1 ケースが 5 秒を超える。
 *
 * 2026-08-28 のゲートで実際に踏んだ:
 *
 * ```
 * FAIL tests/hooks/push-secret-guard.test.ts > 連結されていても捕まえる（秘密情報ありで差分テスト）
 * Error: Test timed out in 5000ms.
 * ```
 *
 * これは**アサーションに到達する前**の偽の赤で、主張そのものは何も変わっていない
 * （CLAUDE.md「まず偽の赤を疑う」）。時間を伸ばしても**検出力は下がらない** ――
 * 下がるのは「アサーションに到達できずに落ちる」確率だけである。
 * `tests/config/create-pull-request-args.test.ts` が同じ理由で同じ手当てをしている。
 */
vi.setConfig({ testTimeout: 30_000 });

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
//
// 🔴 **1 つのリテラルとして書かない（#680 続報）。** 一度は `AKIA` + 16 文字を連結済みの
// 1 リテラルとして書いていたが、これは gitleaks の `aws-access-token` ルールが検出する形
// そのものであり、**このファイル自身が gitleaks の履歴走査対象になる**。
// **この doc comment にもその連結済みの値を書かないこと** —— 書くとコメント自身が新たな
// 検出源になる（`.gitleaksignore` 冒頭の注記と同じ理由で、実際に一度このコメントで踏んだ）。
// PR #684 で
// フィンガープリント（`9f7dcf6e...`）を `.gitleaksignore` に足して受容したところ、
// squash マージでそのコミットの内容が新しい SHA（`5ef205c3...`）で `main` に入り直し、
// フィンガープリントの `<commit>` 部分が一致しなくなって**次の squash merge のたびに
// 同じ検出が再発した**。#682 のレビューでフィンガープリントの厳密さ（4 要素一致でしか
// 黙らせられない）自体は正しいと確認済みなので、指紋を都度貼り替えるのではなく
// **検出される形をソースから無くす**方が根本対応になる。
//
// ランタイムで結合すれば、このファイルの生バイト列に `AKIA[A-Z2-7]{16}` へ一致する
// 連続した 20 文字は一度も現れない（gitleaks は評価済みの値ではなく生テキストを見る）。
// 一方でテンポラリリポジトリへ書き込まれる**結合後の値**は従来と同じ形のままなので、
// フックの実効性（下のテストが実際に検出・ブロックすること）は変わらない。
const FAKE_AWS_KEY = ['AKIA', 'TESTFAKEKEY', '23456'].join('');

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

  it('git push を含まないコマンドは push として分類されない（秘密情報があっても通す）', () => {
    // 🔴 秘密情報が無いリポジトリで status===0 を見るだけでは、「push として認識されな
    // かったから通った」のか「push だと認識されたが検査対象が空だったから通った」のか
    // 区別できない（レビュー指摘）。秘密情報を先に積み、それでも通ることを固定する。
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
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
  it('連結されていても捕まえる（秘密情報ありで差分テスト）', () => {
    // 🔴 秘密情報が無いリポジトリで status===0 を見るだけでは「push として捕まえた上で
    // 許可した」のか「そもそも push として認識していない」のか区別できない
    // （レビュー指摘）。秘密情報を積み、ブロックされる（status 2）ことで
    // 「捕まえている」ことそのものを固定する。
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    for (const cmd of ['npm run build && git push', 'git push; echo done', 'true | true && git push origin HEAD']) {
      expect(runHook(cmd).status, cmd).toBe(2);
    }
  });

  it('改行区切りの複数行コマンドでも捕まえる（先頭行が git で始まらなくても）', () => {
    // 🔴 実際に見逃していたバグ（レビュー指摘）: サニタイズの `tr '\n' ' '` を
    // is_git_push の文分割より先にかけていたため、改行がすべて空白に潰れ、
    // 「先頭行が git で始まらない」複数行コマンドが 1 つの非マッチな文へ結合されて
    // push が一度もスキャンされなかった。これは回避手口ではなく、Bash ツール呼び出し
    // のごく普通の形（このセッションで実際に使われた形）。
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const multiline = ['echo hi', 'git push origin HEAD'].join('\n');
    expect(runHook(multiline).status, multiline).toBe(2);
  });

  it('push が先頭行で、後に別の行が続いても捕まえる', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const multiline = ['git push origin HEAD', 'echo done'].join('\n');
    expect(runHook(multiline).status, multiline).toBe(2);
  });

  it('ヒアドキュメントの後に push が続いても捕まえる', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const multiline = ["cat <<EOF", "some notes here, mentions push casually", "EOF", "git push origin HEAD"].join(
      '\n',
    );
    expect(runHook(multiline).status, multiline).toBe(2);
  });

  it('改行区切りでも、実際に push を含まない複数行コマンドは通す', () => {
    commit(repo, 'leak.env', `AWS_ACCESS_KEY_ID=${FAKE_AWS_KEY}\n`, 'oops: leak');
    const multiline = ['echo hi', 'git log --grep push'].join('\n');
    expect(runHook(multiline).status, multiline).toBe(0);
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
