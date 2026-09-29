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
/**
 * PR #1197（2026-09-29、owner が merge）で main へ入った merge commit。
 *
 * #1181〜#1192（arming 前ブロッカー 12 本）を統合ブランチで束ね、**merge commit で** main へ入れた。
 * 統合ブランチには、force push をせずに旧 head を残すための merge commit と、各 PR の head を
 * 取り込む merge commit が含まれていたので、PR の merge commit 本体（`a1f4dc5`）とあわせて
 * 24 件が main の履歴に載った。事後には直せない。PR 本文とこれらの merge commit の件名が、
 * 取り込んだ各 PR の head SHA を名指ししている（squash すると失われる追跡情報）。
 *
 * 全件が `a1f4dc5` の祖先であることを確かめてから載せた（#1195 の周回で、main の `--full` の
 * unit がこの検査で赤くなったことから）。
 */
const PR_1197_INTEGRATION_MERGES: ReadonlyArray<string> = [
  'a1f4dc57a6d6abe9e8d9ef72e53ee9a3d21e7aac',
  '376ba1a836d0b3bb50674fa4271ebd8b0eb2e4a8',
  'd0a5c6df5bfeb9fc7b1ceedf21cd48854280c22c',
  'f48b0a3cde96e6c32b94eca87e97a773db0f7b5b',
  '535f855f89600cd2b4ee35fc7c206b0aa5ce2b48',
  '679dd646fea456d571232e0cb62a1ee4fb91037e',
  '03f7db761aca292942c1f377e3edabd69f7fa8fa',
  '09e5c6c58fa155a3e99effeb2a3e20e09ad2e4c3',
  '03dec21f49f5ea11cfb6fadf9f1fc3929fb70dc6',
  'e861a29f4965baa51cd9966fbd9b727a334a03a0',
  'a544317c0856bf598a7b6f424bdc53ae338dcb68',
  'ebb8245835d476b3028cce3062d406dd471f356a',
  'b0d7d7959b780a8f28cfe8def0f06bdc36dd349f',
  '8b276b09030670d67c1f8fa4bfd2ba202c581ae4',
  '870a34b523385bc4159f75339349ad2ab57c7ad0',
  '10ded7cb7e57bde805b433bf5054664c509a5470',
  '96741695adb44f6c8b5a1f894ce38900d4f9ed0e',
  'a356f17a70a19d81d5fa0646423a6527d2bbaa71',
  '4212d1c60aaa54efc83dc9746502d61e1bfaabd3',
  'd6b9a74d215309a295259e98d05c5451a3985565',
  '4245760ffa619da2a60ca2c3ceccaf0ebb8aa9ba',
  '90b150518894931d5ea578aee5ca834cd29ce14c',
  '02b1c227af3a4f22de144a81c5776bb79b4e6d18',
  '5d63fc8b193b52dc32571797148aba54c63c3574',
];

const PR_1197_REASON =
  '2026-09-29、owner が #1181〜#1192 の統合 PR #1197 を merge commit で main へ入れた（統合ブランチ内の merge commit を含む）。各 PR の head SHA を履歴に残すための選択で、事後には直せない。';

export const KNOWN_VIOLATIONS: Readonly<Record<string, string>> = {
  e377c9e3ffabef822a14002204143befaf2d7efa:
    '2026-08-09 の 3 本並列委譲で、PR #672 だけクラウドが --squash を使わなかった。指示は --squash だったが、守られたかを見る仕組みがこの時点で無かった（本検査を入れた直接のきっかけ）。',
  ...Object.fromEntries(PR_1197_INTEGRATION_MERGES.map((sha) => [sha, PR_1197_REASON])),
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
