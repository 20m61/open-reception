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
