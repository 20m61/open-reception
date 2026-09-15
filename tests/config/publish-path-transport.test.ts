/**
 * 公開経路（PR 作成・マージ）を **`gh` の無い PATH で実際に走らせる** (#1117 AC1 / AC2)。
 *
 * ## なぜソースの grep では足りないか
 *
 * 「`gh` を呼んでいない」「REST 経路へ import している」はソースを読めば判るが、
 * **呼び出しが残っているか**は判らない。実測: 作成後の引き直し
 * （`pullsQueryRequest` の呼び出し）を丸ごと消す変異が、`import` 行に識別子が
 * 残っているだけで grep 系のテストを**素通りした**。#656 の要点は
 * 「作成できたと言われても信じない」なので、そこが落ちると issue ごと空洞になる。
 *
 * ここでは `curl` と `gh` の**両方を差し替えた PATH** でスクリプトを起動する:
 *
 * - `curl` … 用意した応答を順に返し、渡された argv と stdin を記録する偽物
 * - `gh` … 呼ばれたら**失敗する**偽物。`gh` に戻す退行を PATH の側から捕まえる
 *
 * これで「`gh` が無い環境で PR を作れる」を**環境ごと再現して**確かめられる。
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 子プロセスで TypeScript を起動するので、既定の 5 秒では負荷下で足りない。 */
const SPAWN_TIMEOUT_MS = 30_000;

/** `npx` はレジストリ解決の分だけ余計に待つ。ローカルの tsx を直接呼ぶ。 */
const TSX = join('node_modules', '.bin', 'tsx');

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** 1 回分の応答。`curl -w '\n%{http_code}'` と同じ形（本文 + 改行 + 状態コード）で返す。 */
type StubResponse = { body: string; status: number };

type StubRun = { code: number; stdout: string; stderr: string; dir: string };

/**
 * 偽の `curl` / `gh` を置いた PATH でスクリプトを起動する。
 *
 * `curl --version` は存在確認（`requireCommands`）が呼ぶので、**応答を消費させない**。
 */
function runWithStubs(script: string, args: string[], responses: StubResponse[], env: Record<string, string> = {}): StubRun {
  const dir = mkdtempSync(join(tmpdir(), 'publish-path-'));
  created.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  responses.forEach((r, i) => {
    writeFileSync(join(dir, `response-${i + 1}`), `${r.body}\n${r.status}`);
  });

  const curlStub = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "curl stub"; exit 0; fi
n=$(cat "${dir}/count" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "${dir}/count"
printf '%s\\n' "$*" >> "${dir}/argv.log"
cat > "${dir}/stdin-$n"
if [ -f "${dir}/response-$n" ]; then cat "${dir}/response-$n"; else printf 'no stub response\\n500'; fi
`;
  writeFileSync(join(bin, 'curl'), curlStub);
  chmodSync(join(bin, 'curl'), 0o755);

  // 🔴 `gh` へ戻る退行を PATH の側から捕まえる。呼ばれたら必ず落ちる。
  const ghStub = `#!/usr/bin/env bash
echo "gh was invoked" >> "${dir}/gh.log"
exit 127
`;
  writeFileSync(join(bin, 'gh'), ghStub);
  chmodSync(join(bin, 'gh'), 0o755);

  try {
    const stdout = execFileSync(TSX, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OPEN_RECEPTION_SKIP_GATE_GUARD: '1',
      },
    });
    return { code: 0, stdout, stderr: '', dir };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', dir };
  }
}

function argvLog(dir: string): string {
  try {
    return readFileSync(join(dir, 'argv.log'), 'utf8');
  } catch {
    return '';
  }
}

function callCount(dir: string): number {
  try {
    return Number(readFileSync(join(dir, 'count'), 'utf8').trim());
  } catch {
    return 0;
  }
}

const CREATE = 'scripts/create-pull-request.ts';
const MERGE_SCRIPT = ['scripts', 'merge-pull-request.ts'].join('/');
const PR_URL = 'https://github.com/20m61/open-reception/pull/1234';
const CREATE_ARGS = ['--head', 'feat/x', '--base', 'main', '--title', 'feat: x', '--body', '本文'];

describe('PR 作成: gh の無い PATH で REST だけで作れる (#1117 AC1)', () => {
  it(
    '作成し、実在を引き直して URL を返す',
    () => {
      const run = runWithStubs(CREATE, CREATE_ARGS, [
        { body: JSON.stringify({ html_url: PR_URL }), status: 201 },
        { body: JSON.stringify([{ html_url: PR_URL }]), status: 200 },
      ]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe(PR_URL);
      // 🔴 **作成の 1 回だけでは足りない。** #656 の作法は「引き直して実在を確かめる」。
      expect(callCount(run.dir)).toBe(2);
      expect(argvLog(run.dir)).toContain('/pulls?state=all');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    '🔴 作成が成功したと言われても、引き直して見つからなければ落ちる（#656 の形）',
    () => {
      const run = runWithStubs(CREATE, CREATE_ARGS, [
        { body: JSON.stringify({ html_url: PR_URL }), status: 201 },
        { body: '[]', status: 200 },
      ]);
      expect(run.code).toBe(4);
      expect(run.stderr).toContain('#656');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    '作成が 422 でも、既に PR が在れば成功として扱う（週次 routine の再実行）',
    () => {
      const run = runWithStubs(CREATE, CREATE_ARGS, [
        { body: JSON.stringify({ message: 'already exists' }), status: 422 },
        { body: JSON.stringify([{ html_url: PR_URL }]), status: 200 },
      ]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe(PR_URL);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'gh を一度も呼ばない（PATH 側から捕まえる）',
    () => {
      const run = runWithStubs(CREATE, CREATE_ARGS, [
        { body: JSON.stringify({ html_url: PR_URL }), status: 201 },
        { body: JSON.stringify([{ html_url: PR_URL }]), status: 200 },
      ]);
      expect(() => readFileSync(join(run.dir, 'gh.log'), 'utf8')).toThrow();
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * 🔴 **秘密を argv に載せない。** argv は `ps` から読め、失敗メッセージの整形にも乗る。
   * 下界として「stdin には載っている」（＝ヘッダを送る経路が生きている）も併せて縛る。
   */
  it(
    'token を argv へ載せず、stdin の config で渡す',
    () => {
      const run = runWithStubs(
        CREATE,
        CREATE_ARGS,
        [
          { body: JSON.stringify({ html_url: PR_URL }), status: 201 },
          { body: JSON.stringify([{ html_url: PR_URL }]), status: 200 },
        ],
        { GITHUB_TOKEN: 'tok-must-not-leak', GH_TOKEN: '' },
      );
      expect(run.code).toBe(0);
      expect(argvLog(run.dir)).not.toContain('tok-must-not-leak');
      expect(readFileSync(join(run.dir, 'stdin-1'), 'utf8')).toContain('tok-must-not-leak');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('マージ: gh の無い PATH で REST だけでマージできる (#1117 AC2)', () => {
  it(
    'マージし、状態を引き直して merged を確かめる',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ merged: true }), status: 200 },
      ]);
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe('merged #703');
      expect(callCount(run.dir)).toBe(2);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    '🔴 マージ要求が 200 でも、引き直して merged でなければ落ちる',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ merged: false }), status: 200 },
      ]);
      expect(run.code).toBe(4);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'merged が返ってこない応答を「マージ済み」と読まない',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ state: 'open' }), status: 200 },
      ]);
      expect(run.code).toBe(4);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'squash を明示して送る（既定の merge commit へ倒さない）',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ merged: true }), status: 200 },
      ]);
      expect(argvLog(run.dir)).toContain('merge_method');
      expect(argvLog(run.dir)).toContain('squash');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('前提が欠けたときは、欠けているものを名指しする (#1117 AC1)', () => {
  /**
   * 🔴 **これが #1117 の発端そのもの。** `gh` が無い環境で出ていたのは
   * 「PR の実在を確認できませんでした」という**層の違う**メッセージで、原因に辿り着くには
   * `command -v gh` を別に叩く必要があった。同じ形を `curl` について繰り返さない。
   *
   * `node` だけを置いた PATH でスクリプトを起動する（`curl` は存在しない）。
   */
  it(
    'curl が無い環境では、curl が無いと名指しして落ちる',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'no-curl-'));
      created.push(dir);
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      // `node` と `git` だけを通す。**`curl` は置かない** ―― それがこのテストの条件。
      // （`git` が要るのは owner/repo を remote URL から解決するため。）
      symlinkSync(process.execPath, join(bin, 'node'));
      const git = execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim();
      symlinkSync(git, join(bin, 'git'));

      let stderr = '';
      let code = 0;
      try {
        execFileSync(TSX, [CREATE, ...CREATE_ARGS], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { NODE_ENV: 'test', PATH: bin, OPEN_RECEPTION_SKIP_GATE_GUARD: '1' },
        });
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        code = err.status ?? 1;
        stderr = err.stderr ?? '';
      }

      expect(code).not.toBe(0);
      expect(stderr).toContain('curl');
      // 層を取り違えない ―― 資格情報の話にしない。
      expect(stderr).toContain('バイナリが存在しません');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('失敗した応答の本文を読まない (#1117)', () => {
  /**
   * 🔴 **状態コードを見ずに本文だけ読むと、成功していない操作を成功と報告する。**
   * ここでは「マージ済みと書いてある 401 の応答」を渡す。**認証に失敗しているので
   * その本文は信用できない**。読んでしまうと「マージした」と嘘をつく。
   */
  it(
    'merged と書いてあっても、応答が 2xx でなければマージ済みと読まない',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ merged: true }), status: 401 },
      ]);
      expect(run.code).toBe(4);
      expect(run.stdout).not.toContain('merged #703');
    },
    SPAWN_TIMEOUT_MS,
  );

  /** 下界。2xx なら同じ本文をマージ済みとして読む（「常に落ちる」では満たせない）。 */
  it(
    '2xx で merged なら成功として読む',
    () => {
      const run = runWithStubs(MERGE_SCRIPT, ['--number', '703'], [
        { body: JSON.stringify({ merged: true }), status: 200 },
        { body: JSON.stringify({ merged: true }), status: 200 },
      ]);
      expect(run.code).toBe(0);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('401 は「どの層の話か」までスクリプトの出力へ届く (#1117 review P1)', () => {
  /**
   * 🔴 純関数側で文面を作れても、**I/O 層が出どころを渡さなければ**利用者には届かない。
   * 実測: `tokenSource` を渡さない変異は、純関数のテストだけでは**生存した**。
   */
  it(
    'token 未設定で 401 なら、渡し方を名指しする',
    () => {
      const run = runWithStubs(
        CREATE,
        CREATE_ARGS,
        [
          { body: JSON.stringify({ message: 'Bad credentials' }), status: 401 },
          { body: '[]', status: 200 },
        ],
        { GITHUB_TOKEN: '', GH_TOKEN: '' },
      );
      expect(run.code).toBe(4);
      expect(run.stderr).toContain('gh auth token');
    },
    SPAWN_TIMEOUT_MS,
  );

  /** 下界。渡しているなら「設定されていません」ではなく権限の話にする。 */
  it(
    'token を渡していて 401 なら、権限の話だと言う',
    () => {
      const run = runWithStubs(
        CREATE,
        CREATE_ARGS,
        [
          { body: JSON.stringify({ message: 'Bad credentials' }), status: 401 },
          { body: '[]', status: 200 },
        ],
        { GH_TOKEN: 'some-token' },
      );
      expect(run.code).toBe(4);
      expect(run.stderr).toContain('GH_TOKEN');
      expect(run.stderr).toContain('権限');
      expect(run.stderr).not.toContain('gh auth token');
      // token の値そのものは出さない。
      expect(run.stderr).not.toContain('some-token');
    },
    SPAWN_TIMEOUT_MS,
  );
});
