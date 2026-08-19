/**
 * spec の自由文（`summary` / `extraVerification` / `extraProhibitions`）を検査する (#729)。
 *
 * ## なぜ要るか
 *
 * #710 で委譲プロンプト**生成器の散文**は縛れた。しかし**人が自由文を書く唯一の入口**である
 * spec.json は無検査で、`extraVerification: ['gh pr create --fill で PR を作る']` と書けば
 * そのまま本文に載って委譲先へ届く。生成器が「使わないこと」と書いている隣で、
 * 呼び出し側が壊れたコマンドを配れる —— #678 / #702 の損失（403 になるコマンドを配って
 * 周回を落とす）と同じ経路が開いたままだった。
 *
 * ## 判定の形
 *
 * 🔴 **コマンド名の有無では判定しない。** 「`gh pr create` は使わないこと」という**注意書き**は
 * 正当で、生成器自身も書いている。素の名前で弾くと注意書きごと書けなくなる。
 * #710 で確立した**文単位の役割規則**を使う ——
 * **コマンドに触れてよいのは「禁じる」か「観測を述べる」ときだけ**。
 *
 * ## reject と warn を分ける理由
 *
 * - **実行形は reject**: 403 になるコマンドが委譲先へ届いた時点で 1 周回が落ちる
 * - **緩和語彙は warn**: 生成器側の禁止（`可能なら` 等）を実 spec へそのまま広げると、
 *   **「`npm run x` を実行（可能なら 2 回）」のような正当な指示を弾く**（#710 のレビューで実測）。
 *   語彙は閉集合・日本語の言い換えは開集合なので網羅もできない。**偽陽性の代償の方が大きい**ので、
 *   人へ知らせるところで止める。
 */

/** 自由文を持つフィールド。 */
export type FreeTextField = 'summary' | 'extraVerification' | 'extraProhibitions';

export type FreeTextFinding = {
  readonly field: FreeTextField;
  /** 配列フィールドのときの位置。`summary` では未設定。 */
  readonly index?: number;
  /** `reject` は組み立てを止める、`warn` は知らせるだけ。 */
  readonly severity: 'reject' | 'warn';
  /** 該当した文（人が直せるように、そのまま返す）。 */
  readonly sentence: string;
  readonly message: string;
};

export type SpecFreeText = {
  readonly summary?: string;
  readonly extraVerification?: readonly string[];
  readonly extraProhibitions?: readonly string[];
};

/**
 * クラウドの routine セッションで 403 が観測されているコマンド (#665 / #678 / #702)。
 *
 * ここは**名前だけ**を持つ。実行形かどうかは文脈（下の役割規則）で決める。
 */
const GRAPHQL_BOUND_COMMANDS = ['gh pr create', 'gh pr merge', 'gh pr list', 'gh pr view'] as const;

/**
 * コマンドに触れてよい文脈のしるし。
 *
 * 「禁じている」か「観測を述べている」なら、その文はコマンドを**配っていない**。
 */
const ALLOWED_ROLE = /使わない|使うな|避け|禁止|403|時点の観測|実測/;

/**
 * 🔴 **役割のしるしが救うのは「素の言及」だけ。**
 *
 * フラグや引数を伴う形（`gh pr create --fill` / `gh pr merge 123` / `gh pr view --json`）は、
 * 同じ文に `403` や `使わないこと` を混ぜられても**そのまま実行できてしまう**ので、
 * 文脈によらず拒否する。混ぜれば通る検査は検査ではない。
 */
const EXECUTION_FORM = /(gh pr (?:create|merge|list|view))\s+(?:-{1,2}\S|\d|<)/;

/** 禁止文を骨抜きにしうる緩和表現（**網羅ではない**。warn どまりなのはそのため）。 */
const HEDGING = /(て|で)もよい|(て|で)も構いません|問題ありません|差し支え|可能なら|推奨します|任意/;

/** 文へ割る。`。` と改行の両方で切る（spec は箇条書きも書かれる）。 */
function sentences(text: string): string[] {
  return text
    .split(/[。\n]/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

function inspectOne(field: FreeTextField, text: string, index?: number): FreeTextFinding[] {
  const findings: FreeTextFinding[] = [];
  for (const sentence of sentences(text)) {
    const command = GRAPHQL_BOUND_COMMANDS.find((c) => sentence.includes(c));
    const executable = EXECUTION_FORM.test(sentence);
    if (command !== undefined && (executable || !ALLOWED_ROLE.test(sentence))) {
      findings.push({
        field,
        ...(index === undefined ? {} : { index }),
        severity: 'reject',
        sentence,
        message:
          `\`${command}\` を「禁じる」でも「観測を述べる」でもない文脈で書いています。` +
          `クラウドの routine セッションでは 403 になる観測があり、そのまま委譲先へ配ると 1 周回を失います` +
          `（#678 / #702）。PR 作成は \`scripts/create-pull-request.ts\`、マージは ` +
          `\`scripts/merge-pull-request.ts\`、照会は REST（\`gh api ...\`）を指示してください。`,
      });
      continue;
    }
    if (HEDGING.test(sentence)) {
      findings.push({
        field,
        ...(index === undefined ? {} : { index }),
        severity: 'warn',
        sentence,
        message:
          '緩和表現が入っています。手順の禁止を骨抜きにしていないか確かめてください' +
          '（正当な指示のこともあるので止めません / #729）。',
      });
    }
  }
  return findings;
}

/** 自由文の所見を返す。空なら問題なし。 */
export function inspectSpecFreeText(spec: SpecFreeText): readonly FreeTextFinding[] {
  const findings: FreeTextFinding[] = [];
  if (spec.summary !== undefined) findings.push(...inspectOne('summary', spec.summary));
  for (const [field, values] of [
    ['extraVerification', spec.extraVerification],
    ['extraProhibitions', spec.extraProhibitions],
  ] as const) {
    (values ?? []).forEach((text, index) => findings.push(...inspectOne(field, text, index)));
  }
  return findings;
}
