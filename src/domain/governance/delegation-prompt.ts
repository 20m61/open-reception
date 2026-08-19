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

/**
 * ローカル `--fast` を実際にどうしたか。**呼び出し側が申告する**（生成器は確かめられない）。
 *
 * - `green` … 実行して全 PASS
 * - `not-run` … 実行していない
 * - `failed` … 実行したが green にならなかった（負荷で完走しなかった場合を含む）
 */
export type LocalFastGate = 'green' | 'not-run' | 'failed';

export const LOCAL_FAST_GATE_VALUES: readonly LocalFastGate[] = ['green', 'not-run', 'failed'];

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
  /**
   * ローカル `--fast` の結果。**省略できない** —— 断定を生成器に持たせない (#705)。
   *
   * かつてこの生成器は「ローカル `--fast` は green」を**無条件で**出力していた。入力に
   * 含まれず、生成器には確かめようがない事実である。2026-08-18、ローカル macOS が
   * メモリ枯渇（load 107、空き 529M）で `--fast` を完走できなかった周回でも、生成器は
   * そのまま「green」と書いた。**委譲先はこの散文を前提として受け取り**、ゲートが赤い
   * ときの判断（「ローカルでは通っていたのだから環境要因か」）に使う。前提が嘘だと
   * 判断そのものが狂う。
   */
  localFastGate: LocalFastGate;
  /**
   * `failed` / `not-run` の理由（負荷・環境・未実行など）。
   *
   * `failed` では**必須**（理由の無い「失敗」は委譲先が判断に使えない）。
   */
  localFastGateNote?: string;
  /**
   * どこで止めるか（既定 `'merge'`）。
   *
   * - `'merge'`: 品質ゲート → PR → **squash マージまで**このセッション内で完結させる（従来どおり）。
   * - `'pr'`: 品質ゲート → **PR 作成まで**で止める。マージ可否は人間が判断する
   *   （例: マージ直後に人間が実 IAM を作る等、停止境界に隣接する変更）。
   *
   * 🔴 手書きで `extraProhibitions` に「マージしないこと」を入れても、既定
   * （`'merge'`）では手順側の `gh pr merge` はそのまま残り、1 つのプロンプトの中で
   * 手順と禁止事項が矛盾する（#680 で実際に起きた）。`'pr'` を使えば手順自体が
   * 変わり、マージ禁止も自動で禁止事項へ入るので、呼び出し側が手で書く必要が無い。
   */
  stopAfter?: 'pr' | 'merge';
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
/**
 * 停止境界の扱い (#705)。
 *
 * かつてこの生成器は「**停止境界には触れていません**」と**無条件で**書いていた。生成器は
 * 変更が停止境界に触れるかを判断できず、入力にも含まれていない。憶測をやめ、**実際に
 * 走らせたセッションだけが持つ事実**（ゲート出力の検出器レポート）へ根拠を移す。
 *
 * 検出器そのものは報告専用で偽陽性に倒してある（該当＝即停止ではない。判断基準は
 * `.claude/rules/opus5-autonomous-loop.md`）。だからここで求めるのは**停止ではなく報告**。
 */
const STEP_CHANGE_RISK =
  'ゲート出力の `change-risk (停止境界)` 節を**そのまま報告し、PR 本文の「人間承認が必要な変更」節に貼る**。**この報告が停止境界に触れたかどうかの唯一の根拠です**（依頼文はそれを判断していません）。この検出器は報告専用で偽陽性に倒してあるため、該当があっても自己判断で止めず、**全文を報告**すること。**「判定はできていません」は「当たりなし」ではありません**（測れなかったという意味なので、それも含めてそのまま報告する / #709）。';

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
 * `stopAfter: 'pr'` のとき、呼び出し側の代わりに自動で足すマージ禁止の一文。
 *
 * 🔴 **`gh pr merge` という文字列を書かない。** `stopAfter: 'pr'` の出力には
 * `gh pr merge` がどこにも現れないことをテストで固定している。この文でリテラルに
 * コマンド名を書くと、禁止のつもりの一文自体がその制約を破ってしまう。
 */
const MERGE_PROHIBITION = 'マージしないこと。PR 作成までで止め、マージ可否は人間が判断する。';

/**
 * 禁止事項の中に「マージするな」という趣旨の一文が既にあるかを判定する。
 *
 * `MERGE_PROHIBITION` 自身の文言（マージしない）に加え、呼び出し側が独自に書きうる
 * 表現（マージするな／マージ禁止）も拾う。手順に `gh pr merge` が残ったまま
 * これに一致する禁止事項が入っていたら矛盾（#680 で実際に起きた状態）。
 *
 * 注意（#682 レビュー指摘）: これは `extraProhibitions` の自由記述文に対する**素朴な
 * 正規表現**であり、文脈を見ない。「マージしないこと」以外の意味で「マージ」＋
 * 「しない/するな/禁止」を含む禁止事項（例: 別の対象を指した文）を書くと、意図せず
 * この矛盾検出に引っかかって `throw` する可能性がある。現状の呼び出し元は 1 箇所
 * （`scripts/delegate-gate-prompt.ts` 経由の spec.json）で、実際にそのような文言は
 * 使われていない。リスクは低いが、`extraProhibitions` の入力元が増えるなら見直すこと。
 */
const MENTIONS_MERGE_PROHIBITION = /マージ(しない|するな|禁止)/;

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

  // 🔴 **型だけでは止まらない。** 実際の呼び出し経路は `scripts/delegate-gate-prompt.ts`
  // が spec.json を `as DelegationInput` でキャストするところで、欠けていれば `undefined`
  // が黙って通る。**断定をやめるための申告が、黙って欠けては意味がない**ので実行時にも縛る。
  if (!LOCAL_FAST_GATE_VALUES.includes(input.localFastGate)) {
    throw new Error(
      `localFastGate は ${LOCAL_FAST_GATE_VALUES.map((v) => `'${v}'`).join(' / ')} のいずれかで、省略できません` +
        `（生成器はローカルゲートの結果を確かめられないため申告が要ります / #705）: ${String(input.localFastGate)}`,
    );
  }
  if (input.localFastGate === 'failed' && (input.localFastGateNote ?? '').trim() === '') {
    throw new Error(
      'localFastGate が failed のときは localFastGateNote（理由）が必須です' +
        '（理由の無い「失敗」は委譲先が判断に使えません / #705）',
    );
  }

  const stopAfter = input.stopAfter ?? 'merge';

  const stepCheckout = `\`git fetch origin && git checkout ${input.branch}\` し、\`git rev-parse HEAD\` が \`${input.headSha}\` で始まることを確認する。違えば**そこで止めて報告**する。`;
  // 追加検証は**ビルドとゲートの前**に置く（この周回の目的の確認を先に済ませる）。
  const ordered = [
    stepCheckout,
    STEP_NPM_CI,
    ...(input.extraVerification ?? []),
    STEP_BUILD,
    STEP_GATE,
    STEP_CHANGE_RISK,
  ];

  const refs = input.refs.map((n) => `#${n}`).join(' ');
  const files = input.changedFiles.map((f) => `\`${f}\``).join(' / ');

  // **申告をそのまま書く。生成器は補わない。** `green` 以外では「green」という断定が
  // 出力のどこにも現れないことをテストで固定している。
  const note = (input.localFastGateNote ?? '').trim();
  const localGateLine =
    input.localFastGate === 'green'
      ? `ローカル \`--fast\` は green（呼び出し側の申告${note === '' ? '' : ` / ${note}`}）。`
      : `🔴 **ローカル \`--fast\` は${input.localFastGate === 'failed' ? '失敗しました' : '実行されていません'}**（${note === '' ? '理由の申告なし' : note}）。**このクラウド実行の \`--full\` が唯一の根拠です。** 「ローカルでは通っていたのだから環境要因だろう」という推測をしないこと。`;

  // 手順 11〜12（PR 作成後の扱い）。**名前で持ち、名前で並べる**（配列添字での組み立ては
  // 過去に手順を黙って落とした実績がある。冒頭の doc comment を参照）。
  const stepPrCreate = `green なら次で PR を作る（**\`gh pr create\` は使わないこと** — このセッションでは GraphQL の repo info preamble が 403 になる / #678）:
   \`npx tsx scripts/create-pull-request.ts --head ${input.branch} --base main --title "<下記>" --body "<下記>"\`
   タイトル:
   \`${input.title}\`
   本文には次を必ず含める:
   - 何を変えたか（上記背景の要約）
   - **ゲート結果**: \`--full\` の summary をそのまま貼る
   - **人間承認が必要な変更**: 上記手順で報告した \`change-risk\` の出力を貼り、該当の有無を明記する
   - 末尾に \`Refs ${refs}\``;
  const stepConfirmPr =
    '🔴 **PR の実在は上のコマンドが REST で引き直して確認する**（0 で終われば実在確認済み）。**その URL を報告する。** 非ゼロで終わったら**黙って終わらせず、出力全文を報告**すること。**ブランチが出来たこと＝PR が出来たことではない**（#656 はこれで FAIL の記録を 5 日間失った）。';
  // 🔴 **`gh pr merge` を指示しない (#702)。** クラウドでは GraphQL 403 になる
  // （2026-08-18 / PR #701 で実測。委譲先が現場で REST への回避策を考える羽目になった）。
  // ブランチ削除も proxy が write を拒否するので**指示しない** —— できないことを指示すると、
  // 委譲先はそれを失敗として扱うか、迂回のために余計な判断をする。
  const stepMergeOrStop =
    stopAfter === 'merge'
      ? 'PR が出来たら `npx tsx scripts/merge-pull-request.ts --number <番号>` で squash マージする（**`gh pr merge` は使わないこと** — このセッションでは GraphQL が 403 になる / #702）。マージできたかは同コマンドが REST で引き直して確認する。**リモートブランチの削除は試さなくてよい**（proxy が write を拒否する。ローカル側で後始末します）。'
      : '🔴 **ここで止める。マージコマンドを実行しないこと。** マージ可否は人間が判断するため、PR を作成した時点でこの委譲の作業は完了。';
  const stepFinalReport =
    stopAfter === 'merge'
      ? '最後に次を 1 つずつはっきり報告する: (a) ゲートの結果、(b) PR 番号と URL、(c) マージできたか（`merged=true` を確認したか）。'
      : '最後に次を 1 つずつはっきり報告する: (a) ゲートの結果、(b) PR 番号と URL、(c) マージしていないこと。';

  const allSteps = [...ordered, stepPrCreate, stepConfirmPr, stepMergeOrStop, stepFinalReport];
  const numbered = allSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');

  // `stopAfter: 'pr'` なら呼び出し側が書かなくてもマージ禁止を自動で足す。
  const autoProhibitions = stopAfter === 'pr' ? [MERGE_PROHIBITION] : [];
  const allProhibitions = [...(input.extraProhibitions ?? []), ...autoProhibitions, ...DEFAULT_PROHIBITIONS];

  // **矛盾検出**: 手順に `gh pr merge` があるのに禁止事項へマージ禁止が入っている
  // 組み合わせを投げる（PR タイトルの Conventional Commits 検査と同じ扱い）。
  // `stopAfter: 'pr'` では手順側に `gh pr merge` を置かない設計なので、判定は文字列一致
  // ではなく `stopAfter` そのもので行う（手順の文言を変えても判定がずれない）。
  const stepsContainMerge = stopAfter === 'merge';
  const prohibitionsContainMergeBan = allProhibitions.some((p) => MENTIONS_MERGE_PROHIBITION.test(p));
  if (stepsContainMerge && prohibitionsContainMergeBan) {
    throw new Error(
      '委譲プロンプトが自己矛盾しています: 手順に `gh pr merge` があるのに、禁止事項にマージ禁止が含まれています。' +
        " `extraProhibitions` へマージ禁止を手書きする代わりに `stopAfter: 'pr'` を指定してください。",
    );
  }

  const prohibitions = allProhibitions.map((p) => `- ${p}`).join('\n');

  const openingGoal =
    stopAfter === 'merge'
      ? '品質ゲート → PR → マージまで**このセッション内で完結**させてください。'
      : '品質ゲート → PR 作成まで**このセッション内で完結**させてください（マージはしないこと。マージ可否は人間が判断します）。';

  // `gh pr merge` への言及は `stopAfter: 'merge'` のときだけ（'pr' の出力には
  // `gh pr merge` がどこにも現れないことをテストで固定している）。
  // 🔴 **`gh pr create` も `gh pr merge` も 403 になる (#678 / #702)。**
  // PR #665 の時点では両方通っていた（当時の記述は正しく、今は誤り）。
  // 2026-08-10 に作成が、2026-08-18 にマージが拒否されるのを実測した。
  // **通っていたことを根拠に残さない** —— 実測が変わったら記述を変える。
  const graphqlNote =
    stopAfter === 'merge'
      ? '**`gh pr create` / `gh pr merge` も 403 になる**ので、作成は `scripts/create-pull-request.ts`、マージは `scripts/merge-pull-request.ts`（どちらも REST のみ）を使う。'
      : '**`gh pr create` も 403 になる**ので PR 作成は `scripts/create-pull-request.ts` を使う（マージはしない）。';

  return `リポジトリ 20m61/open-reception のブランチ \`${input.branch}\`（head = \`${input.headSha}\`、base = main \`${input.baseSha}\`）を、${openingGoal}

## 背景（自己完結・追加調査は不要）

${input.summary}

変更ファイル: ${files}

${localGateLine}

## 手順

${numbered}

## 環境の既知の制約

- **クラウドのサンドボックスは GitHub GraphQL を絞っている。** \`gh pr list\` / \`gh pr view --head\` は 403 になる（PR #665 で実測）。PR を探すなら REST（\`gh api repos/{owner}/{repo}/pulls?...\`）を使うこと。${graphqlNote}

## 禁止事項

${prohibitions}
`;
}
