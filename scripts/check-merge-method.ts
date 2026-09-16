/**
 * main の履歴が squash マージだけで出来ているかを検査する (issue #656 の型)。
 *
 * ## なぜ要るか
 *
 * `CLAUDE.md` は「マージ: squash + `--delete-branch`」を規約にしており、委譲プロンプトにも
 * 毎回そう書いている。**だが「そう実行されたか」を誰も見ていなかった。**
 *
 * 2026-08-09、3 本を並列委譲したところ **1 本（PR #672）だけ merge commit で入った**。
 * 指示は `--squash` だったが、クラウド側がそう実行しなかった。ゲートは 13 ステップ全 PASS、
 * PR も作られマージもされたので、**どの検査にも引っかからなかった**。
 *
 * これは #656 とまったく同じ構図 — **指示が散文にあり、守られたかを機械が見ていない**。
 * `docs/ai-development-loop.md` の「規律で守るものを機械検証へ移す」に従って閉じる。
 *
 * ## 判定方法
 *
 * squash マージの結果は**親が 1 つ**のコミットになる。merge commit は**親が 2 つ**。
 * `git log --merges` は後者だけを列挙するので、それがゼロであることを見ればよい。
 *
 * ## 🔴 見るのは **main の履歴**であって、`HEAD` ではない (#1031)
 *
 * かつてここは `HEAD` を走査していた。そのため **feature ブランチで `git merge main` すると、
 * その merge commit が規約違反として検出され**、unit が落ちて `--fast` / `--pr` / `--full` が
 * 全部赤くなった。`pr-gate-guard.sh` が PR 作成もマージもブロックするので、
 * **「main へ追随する」という日常の操作が、そのままループを止めていた**
 * （2026-09-09 の PR #1017 で実際に踏んだ）。
 *
 * しかも赤くなったときの案内は「`KNOWN_VIOLATIONS` へ理由付きで載せろ」なので、
 * **誤った回避策へ誘導していた** —— 載せると、次に本物の逸脱が起きたときに気づけなくなる。
 *
 * 規約は「**main の履歴**が squash だけで出来ていること」である。feature ブランチの
 * merge commit は squash マージで**破棄され、main には決して届かない**。`HEAD` を見るのは、
 * 測りたいもの（main の履歴）の代わりに別のもの（手元の作業履歴）を測っていた。
 *
 * 🔴 **対象を絞っても、#656 が捕まえた本物の欠陥は引き続き検出する** ——
 * 「クラウドが `--squash` を使わず merge commit で **main へ** 入れた」形はまさに main の
 * 履歴に出るので、feature ブランチに立っていても見える。回帰は
 * `merge-scan-ref.test.ts`「main 側の merge commit は、feature ブランチに立っていても検出する」。
 *
 * ## 浅い clone で黙って通さない
 *
 * クラウドの clone は浅いことがある（`git-base.ts` の #557 参照）。**その場合は
 * 見えている範囲だけを検査する** — 見えない部分を「違反なし」と読むより、
 * 見える範囲で確実に落とす方が安全側。同じ理由で、main 系の ref が**どちらも無い**ときは
 * `HEAD` へ倒す（判定できないことを「違反なし」に丸めない）。
 */
import { execFileSync } from 'node:child_process';

/**
 * squash 運用が確立した日。これより前のマージコミットは初期開発期のもので、
 * 履歴は不変なので対象外にする（最後の歴史的マージは 2026-06-18 の PR #64）。
 */
export const SQUASH_CONVENTION_SINCE = '2026-06-19T00:00:00+09:00';

/** マージコミット 1 件。 */
export type MergeCommit = { sha: string; committedAt: string; subject: string };

/**
 * 規約確立後に入った merge commit のうち、**事後には直せない既知の逸脱**。
 *
 * 履歴は書き換えられないので消せない。**理由を残すことが目的** — 同じ形が再発したら
 * ここに載っていない SHA が出てきて落ちる。
 */
export const KNOWN_VIOLATIONS: Readonly<Record<string, string>> = {
  e377c9e3ffabef822a14002204143befaf2d7efa:
    '2026-08-09 の 3 本並列委譲で、PR #672 だけクラウドが --squash を使わなかった。指示は --squash だったが、守られたかを見る仕組みがこの時点で無かった（本検査を入れた直接のきっかけ）。',
};

/** `git log --merges` の 1 行を読む。 */
export function parseMergeLine(line: string): MergeCommit | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  const [sha, committedAt, ...rest] = trimmed.split('\t');
  if (sha === undefined || committedAt === undefined) return undefined;
  return { sha, committedAt, subject: rest.join('\t') };
}

/**
 * git を実行して stdout を返す。失敗は `null`（ref の不在を例外にしない）。
 *
 * 注入できるようにしてあるのは、**実物の git リポジトリを作って検査対象を確かめる**ため
 * （`merge-scan-ref.test.ts`）。「feature ブランチの merge commit を見ない」は
 * 実際に merge commit のあるツリーで走らせないと確かめられない。
 */
export type GitRunner = (args: ReadonlyArray<string>) => string | null;

/** 既定の runner。カレントディレクトリの git を叩く。 */
const defaultRunner: GitRunner = (args) => {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
};

/**
 * 走査対象に使う ref の優先順 (#1031)。
 *
 * remote 追跡を先に見る（ローカル `main` は遅れていることがある）。`git-base.ts` の
 * `BASE_REF_PREFERENCE` と同じ考えだが、**あちらは「差分の起点」、こちらは
 * 「履歴の検査対象」**で目的が違うため、共有せず別に持つ。
 */
export const MERGE_SCAN_REF_PREFERENCE: readonly string[] = ['origin/main', 'main'];

/**
 * 検査対象の ref を決める。どちらの main も見えなければ `HEAD` へ倒す。
 *
 * 🔴 **`HEAD` へ倒すのは「判定できない」を「違反なし」に丸めないため。**
 * その場合は feature ブランチの merge commit も拾ってしまうが、**検査が緩む方向より
 * 厳しい方向の誤りを選ぶ**（この検査が元から採っている判断）。
 */
export function resolveMergeScanRef(run: GitRunner = defaultRunner): string {
  for (const ref of MERGE_SCAN_REF_PREFERENCE) {
    if (run(['rev-parse', '--verify', '--quiet', ref]) !== null) return ref;
  }
  return 'HEAD';
}

/**
 * 規約確立後の merge commit を、**見えている履歴の範囲で**列挙する。
 *
 * `--since` を使うので、浅い clone では単に見える分だけが返る。
 * 走査するのは `resolveMergeScanRef` が決めた **main の履歴**であって `HEAD` ではない (#1031)。
 */
export function findMergeCommitsSinceConvention(run: GitRunner = defaultRunner): MergeCommit[] {
  const ref = resolveMergeScanRef(run);
  const out = run(['log', '--merges', `--since=${SQUASH_CONVENTION_SINCE}`, '--format=%H\t%cI\t%s', ref]);
  // 走査そのものが失敗したら、**空（＝違反なし）と読まない**。呼び出し側へ例外で伝える。
  if (out === null) throw new Error(`merge commit を走査できませんでした（ref: ${ref}）`);
  return out
    .split('\n')
    .map(parseMergeLine)
    .filter((c): c is MergeCommit => c !== undefined);
}

/** 既知の逸脱を除いた、説明の付いていない merge commit。 */
export function findUnexplainedMergeCommits(run: GitRunner = defaultRunner): MergeCommit[] {
  return findMergeCommitsSinceConvention(run).filter((c) => !(c.sha in KNOWN_VIOLATIONS));
}
