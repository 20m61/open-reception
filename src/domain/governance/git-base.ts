/**
 * ゲートの「比較起点（base）」解決を 1 箇所に持つ (#557)。
 *
 * `change-budget.ts`（ゲートの 1 番目）と `change-risk.ts`（末尾）が**同じ解決を別々に
 * 書いていた**。#557 では同一実行の中で前者が「47 ファイル / 2365 行」、後者が「7 件」と
 * 報告した — 直接の原因は浅い clone で `origin/main` がステールなまま 1 番目が走ることだが、
 * **同じ問いに 2 つの実装がある**こと自体が食い違いを見えにくくしていた。
 *
 * ここは「どの ref を優先するか」だけを持つ。**ref を新しくするのはシェル側の責務**
 * （ネットワークアクセスを伴うので、測る側でこっそり fetch しない）。
 */

/** git を実行して stdout を返す。失敗は `null`（呼び出し側で握る）。 */
export type GitRunner = (args: ReadonlyArray<string>) => string | null;

/**
 * 比較起点を解決する。`origin/main` → `main` の順に見て、HEAD との merge-base を返す。
 *
 * `merge-base` まで確認するのが要点。ref が**在る**ことと、そこから HEAD への共通祖先に
 * **到達できる**ことは別で、浅い clone では前者だけ真になり得る。到達できなければ次の
 * 候補へ進み、どれも駄目なら `null`（＝作業ツリーだけ見る）。
 */
export function resolveBase(run: GitRunner, pinned?: string | undefined): string | null {
  /**
   * **シェルが確定した起点を最優先する** (#557 follow-up)。
   *
   * 各消費者が独立に再解決すると、整合の担保が「両方の時点で ref がたまたま同じ」という
   * 時間的性質に戻ってしまう。#557 の症状（同一実行で 47 ファイルと 7 件）はまさにそれで、
   * 共有実装にしただけでは閉じない。`quality-gate.sh` が 1 度だけ解決して
   * `GATE_BASE_SHA` で配り、全員がそれを使うことで**構造的に**同じ起点になる。
   */
  if (pinned !== undefined && pinned.trim() !== '') return pinned.trim();
  for (const ref of BASE_REF_PREFERENCE) {
    if (run(['rev-parse', '--verify', '--quiet', ref]) === null) continue;
    const mergeBase = run(['merge-base', ref, 'HEAD']);
    if (mergeBase !== null && mergeBase.trim() !== '') return mergeBase.trim();
  }
  return null;
}

/** 起点に使う ref の優先順。remote 追跡を先に見る（ローカル `main` は遅れていることがある）。 */
export const BASE_REF_PREFERENCE: readonly string[] = ['origin/main', 'main'];

/** ブランチ ref の接頭辞。`refs/pull/*` や `refs/tags/*` を混ぜないために使う。 */
const HEADS_PREFIX = 'refs/heads/';

/** リモートに実在するブランチ 1 本。`sha` は先端コミット（日時の引き当てに使う）。 */
export type RemoteBranchRef = { name: string; sha: string };

/** リモートの ref 一覧。`git ls-remote --symref origin` 1 回分。 */
export type RemoteRefs = {
  /** 既定ブランチ名。読み取れなければ `undefined`（推測で埋めない）。 */
  defaultBranch: string | undefined;
  /** リモートに実在するブランチ。 */
  branches: RemoteBranchRef[];
};

/**
 * `git ls-remote --symref origin` の出力を読む (#656)。
 *
 * ## なぜこの経路か（2 度外した末に確かめた）
 *
 * orphan ブランチ検査は「既定ブランチを除く、PR が 1 つも無いブランチ」を探すので、
 * 既定ブランチ名とブランチ一覧が要る。クラウドの週次ゲート環境では:
 *
 * 1. `gh repo view --json defaultBranchRef` … 失敗（PR #661 の実走）
 * 2. `git symbolic-ref --short refs/remotes/origin/HEAD` … **その clone に remote 追跡
 *    HEAD が無く**失敗（PR #663 の実走。gh fallback も従来どおり失敗し、結局到達しなかった）
 *
 * `git ls-remote --symref origin` は**リモートに HEAD を尋ねる**ので、ローカルに
 * remote 追跡状態が無くても答えが返る（リポジトリ外から明示 URL で実測して確認）。
 * しかも既定ブランチとブランチ一覧が**1 回の問い合わせ**で揃う。同じクラウドで
 * `git ls-remote --heads origin` は既に成功していた実績もある。
 *
 * ## 読み方
 *
 * ```
 * ref: refs/heads/main<TAB>HEAD      ← 既定ブランチ
 * <sha><TAB>HEAD
 * <sha><TAB>refs/heads/main          ← ブランチ
 * <sha><TAB>refs/pull/106/head       ← 混ぜない
 * ```
 *
 * **読めない形を推測で名前にしない。** 誤った既定ブランチ名で判定すると、実在する既定
 * ブランチが「既定ではない」＝ orphan 候補として誤検出される。
 */
export function parseLsRemoteSymref(output: string): RemoteRefs {
  let defaultBranch: string | undefined;
  const branches: RemoteBranchRef[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [left, right] = trimmed.split('\t');
    if (left === undefined || right === undefined) continue;
    if (left.startsWith('ref: ') && right === 'HEAD') {
      const target = left.slice('ref: '.length);
      if (!target.startsWith(HEADS_PREFIX)) continue;
      const name = target.slice(HEADS_PREFIX.length);
      if (name !== '') defaultBranch = name;
      continue;
    }
    if (!right.startsWith(HEADS_PREFIX)) continue;
    const name = right.slice(HEADS_PREFIX.length);
    if (name !== '') branches.push({ name, sha: left });
  }
  return { defaultBranch, branches };
}

/** GitHub の remote URL から取り出した所有者とリポジトリ名。 */
export type GitHubRepo = { owner: string; repo: string };

/**
 * remote URL から `owner` / `repo` を取り出す (#656)。
 *
 * ## なぜ要るか
 *
 * クラウドのサンドボックスは GitHub GraphQL を絞っており、`gh pr list` は 403 になる:
 *
 * ```
 * HTTP 403: This GraphQL query is not enabled for this session — only the pinned set of
 * PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead.
 * ```
 *
 * REST へ移るには `owner` / `repo` が要る。remote URL から取れば**追加のネットワークは要らない**。
 *
 * **読めなければ推測で組み立てない。** 誤った `owner/repo` で REST を叩くと 404 が返り、
 * 「PR が無い」と誤読して健全なブランチを取りこぼし扱いにしかねない。
 */
export function parseGitHubRepo(remoteUrl: string): GitHubRepo | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed === '') return undefined;
  // `scp` 風（`git@github.com:o/r.git`）と URL 形（`https://…@github.com/o/r.git`）の両方。
  // 資格情報部（`user:pass@`）は捨てる — クラウドの remote はこの形を取る。
  const match = /(?:^|@|\/\/)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo };
}

/**
 * ブランチを head に持つ PR を引く REST パスを組み立てる (#656)。
 *
 * **壊れ方が安全でない向きに倒れるので、生で埋めない。** `head` が落ちた問い合わせは
 * `pulls?state=all&per_page=1` になり、**無関係な PR が 1 件返る**（GitHub API で実測）。
 * 呼び出し側はそれを「PR が在る」と読むため、**本物の取りこぼしを見逃す**。
 * git のブランチ名は `&`（パラメータを割る）も `#`（以降を捨てる）も許すので、
 * エンコードは必須。`%2F` が生の `/` と同じ結果になることも実測で確認済み。
 *
 * `gh pr list` ではなく REST なのは、クラウドのサンドボックスが GraphQL を絞っており
 * 403 になるため（PR #665 の stderr で判明）。
 */
export function pullsQueryPath(repo: GitHubRepo, branch: string): string {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  const head = encodeURIComponent(`${repo.owner}:${branch}`);
  return `repos/${owner}/${name}/pulls?state=all&per_page=1&head=${head}`;
}

/** PR を 1 本作るのに要る最小の内容。 */
export interface PullRequestDraft {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/**
 * PR を **REST で作る** `gh` の引数列を組み立てる (#678)。
 *
 * ## なぜ `gh pr create` を使えないのか
 *
 * `pullsQueryPath` が照会側で踏んだ制約（PR #665）は、**作成側にも当てはまる**。
 * 2026-08-10 の週次ゲート（`record-gate-run.sh --publish`）で実測:
 *
 * ```
 * HTTP 403: This GraphQL query (RepositoryInfo, sent by gh pr create/view (repo info preamble))
 * is not enabled for this session — only the pinned set of PR-review operations is served.
 * Use REST via `gh api repos/{owner}/{repo}/...` instead.
 * ```
 *
 * `gh pr create` は本体の POST の前に repo info の GraphQL preamble を撃つため、
 * **PR 本文が正しくても作成に到達しない**。このとき記録は push 済みで PR だけ無い
 * ―― #656（FAIL が main に載らない）がそのまま再生産される。
 *
 * ## 組み立てで気をつけていること
 *
 * - **値は `-f key=value` の 1 argv 要素**に収める。分割して渡すと本文が引数として散り、
 *   改行を含む body が壊れる（`gh` は `=` の**最初の 1 個**で key と value を割るので、
 *   値の中の `=` は安全）。
 * - **空の head / base / title では組み立てない。** 空 head は 422 で気づけるが、
 *   **空 base は既定ブランチへ倒れうる** ―― 意図しない先へ向いた PR は後から気づきにくい。
 *   `parseGitHubRepo` と同じく「読めなければ推測しない」に倒す。
 * - `--jq .html_url` で URL だけを返す。呼び出し側は #656 の作法に従い、
 *   **返った URL を REST で引き直して実在を確認する**（作成できたという申告を信じない）。
 */
export function pullCreateArgs(repo: GitHubRepo, draft: PullRequestDraft): string[] {
  for (const [label, value] of [
    ['head', draft.head],
    ['base', draft.base],
    ['title', draft.title],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(`PR の ${label} が空です（推測で PR を作らないため組み立てを中止します）`);
    }
  }
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  return [
    'api',
    '--method',
    'POST',
    `repos/${owner}/${name}/pulls`,
    '-f',
    `title=${draft.title}`,
    '-f',
    `head=${draft.head}`,
    '-f',
    `base=${draft.base}`,
    '-f',
    `body=${draft.body}`,
    '--jq',
    '.html_url',
  ];
}

/**
 * PR を **REST で squash マージする** `gh` の引数列を組み立てる (#702)。
 *
 * ## なぜ `gh pr merge` を使えないのか
 *
 * `pullCreateArgs` が作成側で踏んだ制約（#678）は、**マージ側にも当てはまる**。
 * 2026-08-18 の PR #701 のマージで実測:
 *
 * ```
 * gh pr merge 701 --squash --delete-branch
 * non-200 OK status code: 403 Forbidden
 * body: "This GraphQL query is not enabled for this session — only the pinned set of
 *        PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead."
 * ```
 *
 * PR #665 の時点では `gh pr merge` は通っていた（当時の記述は正しく、今は誤り）。
 * **通っていたことを根拠に残さない** ―― 実測が変わったら記述を変える。
 *
 * ## 気をつけていること
 *
 * - **`merge_method=squash` を明示する。** GitHub の既定は merge commit で、
 *   本リポジトリの履歴方針（squash 固定）と食い違う。
 * - **PR 番号は正の整数だけを通す。** 文字列をそのまま埋めると
 *   `701/../../other` のような値でパスを曲げられる。
 */
export function pullMergeArgs(repo: GitHubRepo, pullNumber: number): string[] {
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(`PR 番号が正の整数ではありません: ${pullNumber}`);
  }
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  return [
    'api',
    '--method',
    'PUT',
    `repos/${owner}/${name}/pulls/${pullNumber}/merge`,
    '-f',
    'merge_method=squash',
  ];
}

/** 変更パスの収集結果 (#709)。**失敗を空集合と混ぜない。** */
export type ChangedPathsCollection = {
  /** 集まった変更パス（重複排除済み）。 */
  paths: ReadonlyArray<string>;
  /**
   * 失敗した git コマンド。**空でなければ `paths` は不完全**で、
   * 「変更が無い」と読んではいけない。
   */
  failures: ReadonlyArray<string>;
};

/**
 * 変更パスを集める (#709。`scripts/change-risk.ts` から移設)。
 *
 * ゲートが実際に検査するのは**作業ツリー**なので、ブランチのコミット分と未コミット分の
 * 両方を見る。
 *
 * 🔴 **失敗を `?? ''` で空文字へ落とさない。** 以前はそう書いていたため、`git diff` が
 * 失敗すると**コミット済みの変更が丸ごと消え**、クリーンなツリーでは「変更 0 件」→
 * 「停止境界に触れていません」と断定されていた。浅い clone や `--single-branch` clone で
 * pin された起点の object へ到達できない場合に実際に起こりうる。
 * `change-scope.ts` は同じ状況に既にガードを持っており、こちらだけ無かった。
 */
export function collectChangedPaths(run: GitRunner, base: string | null): ChangedPathsCollection {
  const paths = new Set<string>();
  const failures: string[] = [];

  if (base !== null) {
    const diff = run(['diff', '--name-only', base, 'HEAD']);
    if (diff === null) failures.push(`git diff --name-only ${base} HEAD`);
    else for (const line of diff.split('\n')) addIfPresent(paths, line);
  }

  // 未コミット（staged / unstaged / untracked）。porcelain の先頭 2 桁は状態コード。
  // **`-uall` が必須**: 既定の porcelain は未追跡ディレクトリを `src/foo/` の 1 行へ畳むので、
  // 新しいディレクトリに置いたファイルがまるごと判定から消える（実際に踏んだ）。
  const status = run(['status', '--porcelain', '-uall']);
  if (status === null) failures.push('git status --porcelain -uall');
  else {
    for (const line of status.split('\n')) {
      if (line.trim() === '') continue;
      const path = line.slice(3).trim();
      // リネームは "old -> new" 形式。新しい側を見る。
      addIfPresent(paths, path.includes(' -> ') ? path.split(' -> ')[1]! : path);
    }
  }

  return { paths: [...paths], failures };
}

function addIfPresent(into: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (trimmed !== '') into.add(trimmed);
}
