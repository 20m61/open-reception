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
export function requireCommands(): void {
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
  let stdout: string;
  try {
    stdout = execFileSync('curl', args, {
      encoding: 'utf8',
      input: authConfigInput(token),
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
export function callGitHubJson<T>(request: GitHubRequest): T {
  const response = callGitHub(request);
  if (!isSuccess(response.status)) {
    // **どの環境変数から資格情報を渡したか**を文面へ運ぶ（値は運ばない）。
    // 401 / 403 のとき「そもそも渡していない」と「渡したが足りない」を区別するため。
    throw new Error(
      describeHttpFailure(request, response.status, response.body, resolveGitHubToken(process.env).source),
    );
  }
  try {
    return JSON.parse(response.body === '' ? 'null' : response.body) as T;
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
