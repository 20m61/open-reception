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

/** remote 追跡 HEAD の短縮 ref に付く接頭辞。 */
const ORIGIN_PREFIX = 'origin/';

/**
 * 既定ブランチ名を **gh に頼らず** 解決する (#656)。
 *
 * orphan ブランチ検査（`evaluateRecordBranches`）は「既定ブランチを除く、PR が 1 つも
 * 無いブランチ」を探すので、既定ブランチ名が要る。当初これを
 * `gh repo view --json defaultBranchRef` で取っていたが、**クラウドの週次ゲート環境で
 * 落ちて検査が到達しなかった**（PR #661 の実走で判明。同じセッションで `gh pr create` /
 * `gh pr merge` は成功していたので、落ちたのは gh のリポジトリ解決だけ）。
 *
 * クローン済みリポジトリなら remote 追跡 HEAD から取れる。追加の権限もネットワークも要らない。
 *
 * **読めない形を推測で名前にしない。** 誤った既定ブランチ名で判定すると、実在する既定
 * ブランチが「既定ではない」＝ orphan 候補として誤検出される。読めなければ `undefined` を
 * 返し、呼び出し側の fallback（gh）へ落とす。
 */
export function resolveDefaultBranchName(run: GitRunner): string | undefined {
  const shortRef = run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (shortRef === null) return undefined;
  const trimmed = shortRef.trim();
  if (!trimmed.startsWith(ORIGIN_PREFIX)) return undefined;
  const name = trimmed.slice(ORIGIN_PREFIX.length);
  // 空文字は「問題なし」ではない。通すと全ブランチが「既定ではない」扱いになる。
  return name === '' ? undefined : name;
}
