/**
 * GitHub REST API への話しかけ方を 1 箇所に持つ (#1117)。
 *
 * ## なぜ `gh` をやめたのか
 *
 * これまでの前提は「`gh` は在るが GraphQL が絞られている」だった（#665 / #678 / #702）。
 * 対処は `gh pr create` をやめて `gh api` の REST を使うこと、つまり **`gh` の内側で
 * 経路を選び直すこと**だった。2026-09-15 にその前提ごと外れた:
 *
 * ```
 * $ command -v gh
 * （出力なし）
 * ```
 *
 * Claude Code on the web のサンドボックスに `gh` が無い。PR #1115 / #1116 はどちらも
 * `scripts/create-pull-request.ts` で落ち、GitHub MCP へ手で切り替えて作成した。
 * `record-gate-run.sh --publish` は同じスクリプトへ委ねているので、週次ゲートを
 * 仕掛ければ **記録は push 済み・PR は無し** ―― #656 そのもの ―― が再生産される。
 *
 * 🔴 **同じ形で 3 度直している。** 403 を避けるために `gh` の中で経路を選び直す、を
 * 繰り返してきた。ここでやめるのは**選び直し**の方である:
 * CLI に依存せず、**REST を HTTP でそのまま叩く**。`gh` の有無も認証方式も問わなくなる。
 *
 * ## なぜ node の `fetch` ではなく `curl` なのか（実測 2026-09-15）
 *
 * | 経路 | `GET /repos/20m61/open-reception` |
 * | --- | --- |
 * | `curl`（`HTTPS_PROXY` を見る） | **200** |
 * | node 22 の `fetch`（proxy を見ない） | **401** |
 * | node 22 の `fetch` ＋ `NODE_USE_ENV_PROXY=1` | 200（experimental 警告つき） |
 *
 * このサンドボックスの外向き HTTPS は agent proxy を通り、**proxy が資格情報を差し替える**
 * （ヘッダ無しでも、でたらめな token でも 200 が返ることを実測した）。Node 22 の
 * `fetch` は `HTTPS_PROXY` を見ないので proxy を素通りし、環境変数の token を
 * そのまま GitHub へ送って 401 になる。`undici` を足せば `ProxyAgent` を使えるが、
 * **新規依存は人間承認が要る**（`CLAUDE.md` / #105）。`NODE_USE_ENV_PROXY` は
 * experimental で、しかも起動時にしか効かない。
 *
 * `curl` は proxy と CA を環境変数から自分で解決し、proxy の無い環境（ローカル macOS）
 * でも同じ形で動く。**「どちらでも同じ 1 経路」**が欲しいものなので `curl` を採る。
 *
 * ## ここに置くもの / 置かないもの
 *
 * ここは**純関数だけ**。要求の組み立て・引数列・応答の読み取り・失敗の文面を持ち、
 * プロセス起動は呼び出し側（`scripts/`）が行う。`git-base.ts` から
 * `pullsQueryPath` / `pullCreateArgs` / `pullMergeArgs` を**移設**した（複製ではない）。
 */
import type { GitHubRepo } from './git-base';

/** 使う HTTP メソッドはこの 3 つだけ。**増やすときは pr-gate-guard の判定も見直すこと。** */
export type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * 1 回分の REST 要求。`path` は**ホストを含まない**（`repos/o/r/pulls`）。
 * `body` は JSON テキスト。GET には付けない。
 */
export interface GitHubRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: string;
}

/** API の起点。`gh api` が既定で向いていた先と同じ。 */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

export function requestUrl(request: GitHubRequest): string {
  return `${GITHUB_API_ORIGIN}/${request.path}`;
}

/** 環境変数から解決した token と、その出どころ（報告用。**値は出さない**）。 */
export type TokenResolution = {
  readonly token: string | undefined;
  readonly source: string | undefined;
};

/**
 * 見る環境変数。**`gh` の優先順に揃える** ―― 公式マニュアルの文言は
 * 「`GH_TOKEN`, `GITHUB_TOKEN` (in order of precedence)」で、`GH_TOKEN` が先である
 * （<https://cli.github.com/manual/gh_help_environment>。2026-09-15 に原典で確認）。
 *
 * 🔴 **順序は実害を持つ。** 環境が既定の**制限された** `GITHUB_TOKEN` を配り、利用者が
 * 権限の広い PAT を `GH_TOKEN` で渡す、という形が現実にある。逆順に読むと**黙って別の
 * 主体として**振る舞い、publish の事前確認やマージが「資格情報は正しいのに落ちる」。
 * このサンドボックスは**両方**を設定しているので、ここは絵空事ではない。
 */
const TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * token を解決する。**無くても throw しない。**
 *
 * 🔴 **「token が無い＝publish できない」ではない。** このサンドボックスの agent proxy は
 * 資格情報を注入するので、`Authorization` を送らなくても 200 が返る（2026-09-15 実測）。
 * ここで fail-fast すると、**実際には動く環境を塞ぐ**。
 * 到達性の判定は「環境変数が在るか」ではなく **実際に 1 回引いて確かめる**
 * （`scripts/check-publish-path.ts`）。前提を数え上げず、能力そのものを測る。
 *
 * 空白だけの値は「未設定」として扱う。`${VAR:-}` 由来の空文字がそのまま
 * `Authorization: Bearer ` になると、proxy の注入まで巻き添えに壊しかねない。
 */
export function resolveGitHubToken(env: Readonly<Record<string, string | undefined>>): TokenResolution {
  for (const key of TOKEN_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return { token: value.trim(), source: key };
  }
  return { token: undefined, source: undefined };
}

/**
 * `curl` の引数列を組み立てる。**token を受け取らない**（引数の数がそのまま保証になる）。
 *
 * 🔴 秘密を argv に載せない。argv は `ps` から読めるうえ、失敗メッセージの整形
 * （`describeCommandFailure` は `cmd + args` を連結する）にそのまま乗る。漏らさないよう
 * 気をつけるのではなく、**渡す経路を持たない**ことで塞ぐ。`Authorization` は
 * `--config -` 経由の stdin で渡す（`authConfigInput`）。
 *
 * `--fail` は付けない。4xx の**応答本文にこそ理由が書いてある**ので捨てない。
 * 代わりに `-w` で状態コードを本文の後ろへ 1 行足し、呼び出し側が自分で判定する
 * （`parseCurlResponse`）。
 */
export function curlArgs(request: GitHubRequest): string[] {
  const args = [
    // 🔴 **`-q` は必ず先頭。** curl は既定で `~/.curlrc` を読む。**実測（2026-09-15）**:
    // `write-out = "\nFROM-CURLRC-%{http_code}\n"` を置くと出力へ 1 行混ざり、
    // `parseCurlResponse` の「末尾行が状態コード」が壊れる。`-q` を付けると消えた。
    //
    // 壊れ方は 2 通りあり、どちらも悪い:
    // 1. **秘密が余所へ飛ぶ** … curlrc の `url = …` は**追加の転送**を起こす。
    //    `--config` で渡した `Authorization` はその転送にも乗るので、bearer token が
    //    curlrc の指す先へ送られる
    // 2. **応答が壊れる** … `write-out` / `output` / `silent` 等が出力を変え、
    //    状態コードの読み取りが狂う（善意の curlrc でも起きる）
    //
    // `-q` は**既定の設定ファイルを読む前に**効く必要があるので、位置が意味を持つ。
    // 後ろに置くと、読んでから無効化することになり 1 も 2 も防げない。
    '-q',
    '-sS',
    '--config',
    '-',
    '-X',
    request.method,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
    '-H',
    'User-Agent: open-reception',
  ];
  if (request.body !== undefined) {
    // 🔴 **`--data-binary` は先頭 `@` を「ファイルから読め」と解釈する。** 本体は必ず
    // `JSON.stringify` の出力（`{` か `[` で始まる）なので起こらないが、起こったときの
    // 壊れ方が「ローカルのファイルを GitHub へ送る」なので、**起こらないことを確かめる**。
    if (!/^[{[]/.test(request.body)) {
      throw new Error(`要求の本体が JSON ではありません（先頭: ${JSON.stringify(request.body.slice(0, 8))}）`);
    }
    args.push('-H', 'Content-Type: application/json', '--data-binary', request.body);
  }
  args.push('-w', '\\n%{http_code}', requestUrl(request));
  return args;
}

/**
 * `curl --config -` へ流し込む設定テキスト。token が無ければ**空**（ヘッダを送らない）。
 *
 * 空ヘッダを送らないことが要点。proxy が注入する環境で `Authorization: Bearer ` を
 * 送ると、注入側と衝突しうる。
 */
export function authConfigInput(token: string | undefined): string {
  if (token === undefined || token.trim() === '') return '';
  return `header = "Authorization: Bearer ${token.trim()}"\n`;
}

/** この経路が要る外部コマンド。**`gh` はもう要らない**のが #1117 の要点。 */
export const REQUIRED_REST_COMMANDS: ReadonlyArray<string> = ['curl'];

/**
 * 欠けている外部コマンドを**名指しする**文面 (#1117 AC1)。
 *
 * 🔴 **層を取り違えたメッセージを出さない。** #1117 の発端は、`gh` が無い環境で
 * 「PR の実在を確認できませんでした」という**別の層**の文言が出ていたことだった。
 * 原因に辿り着くのに `command -v gh` を別に叩く必要があり、その間 PR は作れないまま
 * だった。`command-preflight.ts` が `aws` について同じ失敗から学んだのと同型なので、
 * **資格情報の話ではないこと**を明示する。
 */
export function formatMissingRestCommands(missing: ReadonlyArray<string>): string {
  return (
    `GitHub REST を叩くのに必要なコマンドがありません: ${missing.join(', ')}。` +
    '（資格情報の問題ではありません。バイナリが存在しません。）'
  );
}

/** 応答。`status` は HTTP の状態コード、`body` は本文（JSON テキストのことが多い）。 */
export type GitHubResponse = { readonly status: number; readonly body: string };

/**
 * `curl -w '\n%{http_code}'` の出力を読む。
 *
 * 🔴 **末尾行が 3 桁でなければ throw する。** 書き出しが落ちた出力から「最後に見つかる
 * 数字」を拾うと、本文しか返っていない応答を 200 と誤読して**失敗を成功として通す**。
 * 読めなかったことは読めなかったとして扱う。
 */
export function parseCurlResponse(stdout: string): GitHubResponse {
  const cut = stdout.lastIndexOf('\n');
  const tail = cut === -1 ? stdout : stdout.slice(cut + 1);
  if (!/^\d{3}$/.test(tail)) {
    throw new Error(
      `curl の出力から HTTP ステータスを読めませんでした（末尾行: ${JSON.stringify(tail)}）。` +
        '応答を成功と読まずに中止します。',
    );
  }
  return { status: Number(tail), body: cut === -1 ? '' : stdout.slice(0, cut) };
}

/** 2xx だけを成功とする。3xx は**追いかけない**（`-L` を付けていないので素直に失敗させる）。 */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * 失敗を、**次に何をすればよいか読める形**へ整形する。
 *
 * 応答本文を落とさないのが要点。GitHub の 403 / 422 は理由を本文にだけ書く。
 * 要求側から持ち出すのは method と path だけで、**ヘッダには触れない**
 * （`Authorization` を文面へ運ばない）。
 */
export function describeHttpFailure(
  request: GitHubRequest,
  status: number,
  body: string,
  tokenSource?: string | undefined,
): string {
  const base = `GitHub REST が ${status} を返しました: ${request.method} ${request.path}\n  応答: ${body.trim()}`;
  return status === 401 || status === 403 ? `${base}\n  ${describeMissingCredential(tokenSource)}` : base;
}

/**
 * 401 / 403 のときに、**どの層の話か**を添える (#1117 の review P1)。
 *
 * 🔴 **`gh auth login` の資格情報は環境変数に出ない。** macOS では keychain に入るので、
 * `gh` でログイン済みの端末でも `GH_TOKEN` / `GITHUB_TOKEN` は空のままになる。
 * ここを書かないと、**ログインしているのに 401**という、原因の見えない失敗になる ――
 * `gh` が無いのに「PR の実在を確認できませんでした」と言っていた #1117 と同じ型である。
 *
 * **`gh auth token` を内部で呼んで補わないのは意図的。** それをすると、この変更が
 * 外したはずの `gh` 依存が資格情報の層から戻ってくる。`gh` の有無に依らないことが
 * この経路の取り柄なので、**足さずに、渡し方を名指しする**。
 */
function describeMissingCredential(tokenSource: string | undefined): string {
  if (tokenSource !== undefined) return `（資格情報は ${tokenSource} から渡しています。権限を確認してください。）`;
  return (
    'GH_TOKEN / GITHUB_TOKEN のどちらも設定されていません。' +
    '`gh auth login` の資格情報は環境変数には現れない（keychain 等に入る）ので、' +
    'ローカルで使うときは `GH_TOKEN="$(gh auth token)"` のように明示的に渡してください。'
  );
}

/** 能力判定の結果。**通らなかった理由を必ず持つ**（黙って false にしない）。 */
export type PushCapabilityVerdict = { readonly ok: boolean; readonly reason: string };

/**
 * `GET /repos/{owner}/{repo}` の応答から「この主体は push できるか」を判定する (#1117)。
 *
 * 🔴 **判定不能を PASS へ丸めない。** `permissions` が返らないトークン種別があるので、
 * **返らなかったことを「権限あり」と読まない**。`command-preflight.ts` の
 * `observed[cmd] !== true` と同じ倒し方。
 *
 * ⚠️ **これは push 権限の**申告**であって、PR を作れること・マージできることの保証では
 * ない**（保護ブランチ・レビュー必須・App のスコープはここに現れない）。
 * 20 分のゲートを回す前に**確実に無理な場合を落とす**ための下限の検査である。
 */
export function evaluatePushCapability(payload: unknown): PushCapabilityVerdict {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'リポジトリの応答を JSON オブジェクトとして読めませんでした' };
  }
  // 配列や別形の JSON もここで落ちる（`permissions` を持たないため）。**型の場合分けを
  // 増やさない** —— 増やしても判定は変わらず、分岐だけが増える。
  const permissions = (payload as { permissions?: unknown }).permissions;
  if (typeof permissions !== 'object' || permissions === null) {
    return { ok: false, reason: '応答に permissions がありません（権限を確認できませんでした）' };
  }
  if ((permissions as { push?: unknown }).push !== true) {
    return { ok: false, reason: 'このリポジトリへの push 権限がありません' };
  }
  return { ok: true, reason: '' };
}

/** PR 番号として通してよい値だけを通す。パスへ生で埋めると `9/../../x` で曲げられる。 */
function assertPullNumber(pullNumber: number): void {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(`PR 番号が正の整数ではありません: ${pullNumber}`);
  }
}

/** `owner` / `repo` をパスへ安全に埋める。 */
function repoPath(repo: GitHubRepo): string {
  return `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/**
 * ブランチを head に持つ PR を引く要求 (#656 から移設)。
 *
 * **壊れ方が安全でない向きに倒れるので、生で埋めない。** `head` が落ちた問い合わせは
 * `pulls?state=all&per_page=1` になり、**無関係な PR が 1 件返る**（GitHub API で実測）。
 * 呼び出し側はそれを「PR が在る」と読むため、**本物の取りこぼしを見逃す**。
 * git のブランチ名は `&`（パラメータを割る）も `#`（以降を捨てる）も許すので、
 * エンコードは必須。`%2F` が生の `/` と同じ結果になることも実測で確認済み。
 */
export function pullsQueryRequest(repo: GitHubRepo, branch: string): GitHubRequest {
  const head = encodeURIComponent(`${repo.owner}:${branch}`);
  return { method: 'GET', path: `${repoPath(repo)}/pulls?state=all&per_page=1&head=${head}` };
}

/** PR を 1 本作るのに要る最小の内容。 */
export interface PullRequestDraft {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/**
 * PR を作る要求 (#678 から移設)。
 *
 * **空の head / base / title では組み立てない。** 空 head は 422 で気づけるが、
 * **空 base は既定ブランチへ倒れうる** ―― 意図しない先へ向いた PR は後から気づきにくい。
 * `parseGitHubRepo` と同じく「読めなければ推測しない」に倒す。
 *
 * 本体は JSON にする。`gh api` の `-f key=value` はキーと値を `=` で割る形式で、
 * **改行や `=` を含む PR 本文の扱いが形式そのものに依存していた**。JSON なら
 * エンコードが 1 段で済み、値がそのまま往復する。
 */
export function pullCreateRequest(repo: GitHubRepo, draft: PullRequestDraft): GitHubRequest {
  for (const [label, value] of [
    ['head', draft.head],
    ['base', draft.base],
    ['title', draft.title],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`PR の ${label} が空です（推測で PR を作らないため組み立てを中止します）`);
    }
  }
  return {
    method: 'POST',
    path: `${repoPath(repo)}/pulls`,
    body: JSON.stringify({
      title: draft.title,
      head: draft.head,
      base: draft.base,
      body: draft.body,
    }),
  };
}

/**
 * PR を squash マージする要求 (#702 から移設)。
 *
 * **`merge_method=squash` を明示する。** GitHub の既定は merge commit で、
 * 本リポジトリの履歴方針（squash 固定）と食い違う。
 */
export function pullMergeRequest(repo: GitHubRepo, pullNumber: number): GitHubRequest {
  assertPullNumber(pullNumber);
  return {
    method: 'PUT',
    path: `${repoPath(repo)}/pulls/${pullNumber}/merge`,
    body: JSON.stringify({ merge_method: 'squash' }),
  };
}

/** PR 1 本の現状を引く要求（マージできたかを**引き直して**確かめるのに使う）。 */
export function pullReadRequest(repo: GitHubRepo, pullNumber: number): GitHubRequest {
  assertPullNumber(pullNumber);
  return { method: 'GET', path: `${repoPath(repo)}/pulls/${pullNumber}` };
}

/** リポジトリ 1 件を引く要求（publish 経路の到達性と push 権限の確認に使う）。 */
export function repoReadRequest(repo: GitHubRepo): GitHubRequest {
  return { method: 'GET', path: repoPath(repo) };
}
