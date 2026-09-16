/**
 * `scripts/` から GitHub REST API を叩く I/O 層 (#1117)。
 *
 * 判定・組み立て・文面は `src/domain/governance/github-rest.ts`（純関数）に在る。
 * ここはプロセス起動と、その失敗の握り方だけを持つ。
 *
 * 🔴 **`gh` を呼ばない。** 2026-09-15、Claude Code on the web のサンドボックスに `gh` が
 * 無いことが判明し、PR 作成もマージも落ちた。理由と `curl` を選んだ実測は
 * `src/domain/governance/github-rest.ts` の冒頭に書いてある。
 */
import { execFileSync } from 'node:child_process';
import { describeCommandFailure } from '../../src/domain/governance/command-failure';
import { evaluateCommandAvailability } from '../../src/domain/governance/command-preflight';
import { parseGitHubRepo, type GitHubRepo } from '../../src/domain/governance/git-base';
import {
  authConfigInput,
  curlArgs,
  describeHttpFailure,
  formatMissingRestCommands,
  isSuccess,
  parseCurlResponse,
  REQUIRED_REST_COMMANDS,
  resolveGitHubToken,
  type GitHubRequest,
  type GitHubResponse,
} from '../../src/domain/governance/github-rest';

/** 外部コマンドを実行する。失敗したら理由（stderr）まで載せて投げ直す。 */
export function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(describeCommandFailure(`${cmd} ${args.join(' ')}`, e));
  }
}

/**
 * `curl` が在ることを確かめる。
 *
 * 🔴 **無いものを名指しする。** #1117 の発端は、`gh` が無い環境で
 * 「PR の実在を確認できませんでした」という**層の違う**メッセージが出ていたことだった。
 * 原因が判るまで `command -v gh` を別に叩く必要があった。同じ形を持ち込まない。
 */
let commandsVerified = false;

export function requireCommands(): void {
  // 1 プロセス 1 回でよい。`evaluate-gate-runs` はブランチ本数ぶん REST を叩くので、
  // 毎回 `curl --version` を spawn すると純粋な待ち時間になる (#1117 review m8)。
  if (commandsVerified) return;
  const observed: Record<string, boolean> = {};
  for (const cmd of REQUIRED_REST_COMMANDS) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      observed[cmd] = true;
    } catch {
      observed[cmd] = false;
    }
  }
  const verdict = evaluateCommandAvailability(observed, REQUIRED_REST_COMMANDS);
  if (!verdict.ok) throw new Error(formatMissingRestCommands(verdict.missing));
  commandsVerified = true;
}

/**
 * REST を 1 回叩く。**HTTP の失敗では throw しない**（状態コードをそのまま返す）。
 *
 * token は stdin の `--config` で渡す。argv には載せない（`github-rest.ts` 参照）。
 * 通信そのものに失敗したときだけ throw する。
 */
export function callGitHub(request: GitHubRequest): GitHubResponse {
  requireCommands();
  const { token } = resolveGitHubToken(process.env);
  const args = curlArgs(request);
  // 🔴 **`authConfigInput` の throw を try の中で起こさない** (#1117 独立レビュー 2 周目)。
  // 引数位置で評価すると `describeCommandFailure`（`error.stderr` しか拾わない）に飲まれ、
  // 「token に使えない文字が含まれています」が 1 文字も出ずに
  // 「GitHub REST へ到達できませんでした」になる ―― **#1117 が消そうとした
  // 「層を取り違えたメッセージ」そのもの**。先に評価して、理由をそのまま投げる。
  const input = authConfigInput(token);
  let stdout: string;
  try {
    stdout = execFileSync('curl', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // **argv から組み立てる**。`authConfigInput` の中身（token）はここに現れない。
    throw new Error(describeCommandFailure(`curl ${args.join(' ')}`, e));
  }
  return parseCurlResponse(stdout);
}

/**
 * REST を 1 回叩き、2xx なら本文を JSON として返す。2xx でなければ throw する。
 *
 * 失敗の文面には**応答本文を残す**（GitHub の 403 / 422 は理由を本文にしか書かない）。
 */
/**
 * 一覧を期待する要求。**配列でなければ失敗させる** (#1117 独立レビュー 2 周目)。
 *
 * 🔴 **`length === 0` は形の検査ではない。** 配列でない JSON では `undefined === 0` が
 * false になり、**「PR が 1 件以上ある」と読まれる**。実測で、2 回目の応答を
 * 200 `{"message":"…"}` にすると `create-pull-request.ts` が
 * 「✅ PR の実在を REST で確認しました」と言って 0 で終わった ―― PR は存在しない。
 *
 * transport が `gh api`（非 2xx を gh 自身が失敗にする）から `curl` ＋ 介在 proxy へ
 * 移ったことで、**200 + 非配列 JSON の到達性が上がっている**（この環境の proxy は
 * 403 / 405 / 407 を返しうると README 自身が書いている）。#656 の砦をそこに預けない。
 */
export function callGitHubArray(request: GitHubRequest): unknown[] {
  const value = callGitHubJson<unknown>(request);
  if (!Array.isArray(value)) {
    throw new Error(
      `GitHub REST の応答が一覧ではありません: ${request.method} ${request.path}\n` +
        `  受け取った形: ${Object.prototype.toString.call(value)}`,
    );
  }
  return value;
}

export function callGitHubJson<T>(request: GitHubRequest): T {
  const response = callGitHub(request);
  if (!isSuccess(response.status)) {
    // **どの環境変数から資格情報を渡したか**を文面へ運ぶ（値は運ばない）。
    // 401 / 403 のとき「そもそも渡していない」と「渡したが足りない」を区別するため。
    throw new Error(
      describeHttpFailure(request, response.status, response.body, resolveGitHubToken(process.env).source),
    );
  }
  // 🔴 **空本文を `null` へ倒さない (#1117 review m7)。** 倒すと呼び出し側が
  // `null.length` / `null.merged` で TypeError になり、**判定不能が素の例外に化ける**
  // ―― `evaluate-gate-runs` では `branch_check_unverified` にすらならない。
  // ここで叩く経路はすべて JSON を返すので、空は異常として名指しする。
  if (response.body.trim() === '') {
    throw new Error(`GitHub REST が空の本文を返しました: ${request.method} ${request.path}`);
  }
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(
      `GitHub REST の応答を JSON として読めませんでした: ${request.method} ${request.path}`,
    );
  }
}

/**
 * `origin` の URL から `owner` / `repo` を取る。**追加のネットワークも GraphQL も要らない。**
 *
 * 読めなければ `undefined` を返さず throw する ―― 誤った `owner/repo` で REST を叩くと
 * 404 が返り、「PR が無い」と誤読して健全なブランチを取りこぼし扱いにしかねない。
 */
export function resolveRepoFromOrigin(): GitHubRepo {
  const remoteUrl = run('git', ['ls-remote', '--get-url', 'origin']);
  const repo = parseGitHubRepo(remoteUrl);
  if (repo === undefined) {
    throw new Error(`origin の URL から owner/repo を読み取れませんでした: ${remoteUrl}`);
  }
  return repo;
}
