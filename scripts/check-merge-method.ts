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
 * ## 浅い clone で黙って通さない
 *
 * クラウドの clone は浅いことがある（`git-base.ts` の #557 参照）。**その場合は
 * 見えている範囲だけを検査する** — 見えない部分を「違反なし」と読むより、
 * 見える範囲で確実に落とす方が安全側。
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
 * 規約確立後の merge commit を、**見えている履歴の範囲で**列挙する。
 *
 * `--since` を使うので、浅い clone では単に見える分だけが返る。
 */
export function findMergeCommitsSinceConvention(): MergeCommit[] {
  const out = execFileSync(
    'git',
    ['log', '--merges', `--since=${SQUASH_CONVENTION_SINCE}`, '--format=%H\t%cI\t%s', 'HEAD'],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map(parseMergeLine)
    .filter((c): c is MergeCommit => c !== undefined);
}

/** 既知の逸脱を除いた、説明の付いていない merge commit。 */
export function findUnexplainedMergeCommits(): MergeCommit[] {
  return findMergeCommitsSinceConvention().filter((c) => !(c.sha in KNOWN_VIOLATIONS));
}
