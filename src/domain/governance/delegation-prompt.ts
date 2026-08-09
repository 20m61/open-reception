/**
 * クラウド委譲プロンプトの生成 (issue #656 の型を委譲側へ適用)。
 *
 * ## なぜ要るか
 *
 * `--pr` / `--full` はクラウド routine へ委譲する運用だが（`CLAUDE.md`）、その指示は
 * **毎回ゼロから手書きされていた**。2026-08-08〜09 の 1 日で 13 回、いずれも 60 行前後。
 * 文言は毎回わずかに違い、抜けても誰も気づかない:
 *
 * - `build:open-next` を書き忘れる → `.open-next` が stale でゲートが green を記録しない
 * - 「PR の実在を確認せよ」を書き忘れる → **#656 そのもの**（ブランチはできたが PR が無い）
 * - 「要約の緑だけを信じるな」を書き忘れる → infra の skip 混じりを本物の green と誤読
 *
 * **これは #656 の根本（保証が散文にある）を、委譲の仕組みで再生産している。**
 * `docs/ai-development-loop.md` の「規律で守るものを機械検証へ移す」に従い、
 * 不変部分をコードへ移して**引数だけを可変**にする。
 *
 * ## 何を自動化しないか
 *
 * routine の作成そのものは自動化できない。`RemoteTrigger` は認証がプロセス内にある
 * ツールで、リポジトリのスクリプトからは叩けない。**ここが生成するのは本文だけ**で、
 * 送信は呼び出し側が行う。MCP コネクタの解除（`clear_mcp_connections`）も送信側の責務。
 */

/** 委譲 1 件分の可変部分。 */
export type DelegationInput = {
  /** 対象ブランチ名。 */
  branch: string;
  /** 検証させる head の短縮 SHA。**取り違え防止のためこれを必ず突き合わせさせる。** */
  headSha: string;
  /** base（main）の短縮 SHA。 */
  baseSha: string;
  /** PR タイトル。**squash 後の main コミットになる**ので Conventional Commits 必須。 */
  title: string;
  /** 何を変えたかの説明（PR 本文にも入る）。 */
  summary: string;
  /** 変更したファイルの一覧（人が見て範囲を掴めるように）。 */
  changedFiles: readonly string[];
  /** この周回だけの追加検証手順（任意）。 */
  extraVerification?: readonly string[];
  /** この周回だけの追加禁止事項（任意）。 */
  extraProhibitions?: readonly string[];
  /** 関連 issue 番号（`Refs #N` に使う）。 */
  refs: readonly number[];
};

/** Conventional Commits の形か。`type(scope): 説明` / `type: 説明` を許す。 */
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;

/**
 * 毎回書いていた検証手順のうち、**抜けると実害が出たもの**。
 *
 * 🔴 **配列の添字で組み立てない。** 最初そう書いたところ、追加検証がある場合に
 * **ゲートの手順そのものを落としていた**（テストが検出）。手順が黙って消えるのは、
 * この仕組みが無くそうとしている欠陥そのもの。名前で持ち、名前で並べる。
 */
const STEP_NPM_CI = '`npm ci`';
const STEP_BUILD =
  '`npm run build:open-next` を実行する（3〜5 分）。**これを飛ばすと `.open-next` が stale 扱いになり、ゲートは green として記録しません。**';
const STEP_GATE =
  '`./scripts/quality-gate.sh --full` を実行する。summary の全ステップが PASS であることを確認する。**要約の緑だけを信じず、log 本文で実際に走ったコマンド行を確認する。** infra の `Tests` 行が skip を含むなら**偽の green**です（`138 passed (138)` が本物）。FAIL は**直さずに**全文報告して止める。';

/** 毎回書いていた禁止事項。 */
const DEFAULT_PROHIBITIONS: readonly string[] = [
  'テストの削除・skip・弱体化、型安全性の低下で green にしないこと',
  '`--no-verify` を使わないこと',
  '指示のない issue をクローズしないこと',
  '変更の範囲を広げないこと',
];

/**
 * 委譲プロンプト本文を組み立てる。
 *
 * **タイトルが Conventional Commits でなければ投げる。** squash 後の main コミットに
 * なるので、ここを間違えると履歴が汚れ、後から直せない（`CLAUDE.md` 規約）。
 */
export function buildDelegationPrompt(input: DelegationInput): string {
  if (!CONVENTIONAL.test(input.title)) {
    throw new Error(
      `PR タイトルが Conventional Commits ではありません（squash 後の main コミットになります）: ${input.title}`,
    );
  }
  if (input.headSha.trim() === '') throw new Error('headSha は必須です（ブランチ取り違えの検出に使います）');

  const stepCheckout = `\`git fetch origin && git checkout ${input.branch}\` し、\`git rev-parse HEAD\` が \`${input.headSha}\` で始まることを確認する。違えば**そこで止めて報告**する。`;
  // 追加検証は**ビルドとゲートの前**に置く（この周回の目的の確認を先に済ませる）。
  const ordered = [stepCheckout, STEP_NPM_CI, ...(input.extraVerification ?? []), STEP_BUILD, STEP_GATE];

  const numbered = ordered.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const refs = input.refs.map((n) => `#${n}`).join(' ');
  const prohibitions = [...(input.extraProhibitions ?? []), ...DEFAULT_PROHIBITIONS]
    .map((p) => `- ${p}`)
    .join('\n');
  const files = input.changedFiles.map((f) => `\`${f}\``).join(' / ');

  return `リポジトリ 20m61/open-reception のブランチ \`${input.branch}\`（head = \`${input.headSha}\`、base = main \`${input.baseSha}\`）を、品質ゲート → PR → マージまで**このセッション内で完結**させてください。

## 背景（自己完結・追加調査は不要）

${input.summary}

変更ファイル: ${files}。**停止境界には触れていません**。ローカル \`--fast\` は green。

## 手順

${numbered}
${ordered.length + 1}. green なら \`gh pr create --base main --head ${input.branch}\` で PR を作る。タイトル:
   \`${input.title}\`
   本文には次を必ず含める:
   - 何を変えたか（上記背景の要約）
   - **ゲート結果**: \`--full\` の summary をそのまま貼る
   - **人間承認が必要な変更**: 該当の有無を明記する
   - 末尾に \`Refs ${refs}\`
${ordered.length + 2}. 🔴 **PR が実際に作成されたことを \`gh pr view --json number,url\` で確認して番号を報告する。** 作成に失敗した場合は**黙って終わらせず、エラー全文を報告**すること。**ブランチが出来たこと＝PR が出来たことではない**（#656 はこれで FAIL の記録を 5 日間失った）。
${ordered.length + 3}. PR が出来たら \`gh pr merge <番号> --squash --delete-branch\` でマージする。ブランチが残っても構いません（ローカル側で後始末します）。
${ordered.length + 4}. 最後に次を 1 つずつはっきり報告する: (a) ゲートの結果、(b) PR 番号と URL、(c) マージできたか、(d) リモートブランチが消えたか。

## 環境の既知の制約

- **クラウドのサンドボックスは GitHub GraphQL を絞っている。** \`gh pr list\` / \`gh pr view --head\` は 403 になる（PR #665 で実測）。PR を探すなら REST（\`gh api repos/{owner}/{repo}/pulls?...\`）を使うこと。\`gh pr create\` / \`gh pr merge\` は通る。

## 禁止事項

${prohibitions}
`;
}
