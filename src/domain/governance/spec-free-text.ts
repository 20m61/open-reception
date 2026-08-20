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
/**
 * クラウドの routine セッションで 403 が観測されている経路 (#665 / #678 / #702)。
 *
 * `gh pr <sub>` はほぼ全部が GraphQL 経路で、`gh api graphql` は直撃。
 * **実測したのは create / merge / list / view と `gh issue view`**（このセッション）で、
 * 残りは同じ経路を通るという**推定**。推定側は誤検知の害が小さい（素の言及は通る）ので広く取る。
 */
const GRAPHQL_BOUND_COMMANDS = [
  'gh api graphql',
  'gh pr create',
  'gh pr merge',
  'gh pr list',
  'gh pr view',
  'gh pr edit',
  'gh pr ready',
  'gh pr comment',
  'gh pr review',
  'gh pr checkout',
  'gh pr status',
  'gh pr diff',
] as const;

/**
 * コマンドに触れてよい文脈のしるし。
 *
 * 「禁じている」か「観測を述べている」なら、その文はコマンドを**配っていない**。
 */
const ALLOWED_ROLE = /使わない|使うな|避け|禁止|403|時点の観測|実測/;

/**
 * しるしを探す窓の幅。**コマンドの直後**だけを見る。
 *
 * 🔴 **文スコープでは広すぎた（#729 レビュー M-1）。** 文のどこかに `403` があれば通る規則は、
 * `403 は解消済みなので \`gh pr create\` で PR を作る` を**素通りさせる** —— `403` は
 * この話題を書けばほぼ必ず同居するトークンなので、実質「話題に触れた文を全部許す」に等しかった。
 * 生成された本文では、この文が手順 3 に載る一方で手順 7 が「使わないこと」と言い、
 * 委譲先がどちらを信じるか判断を強いられる（#680 と同じ状態）。
 *
 * 🔴 **逆に、フラグの有無で決めるのも間違いだった（同 M-2）。**
 * `\`gh pr view --head\` が 403 でした（2026-08-03 時点の観測）` は**生成器自身が本文へ出している
 * 観測文そのもの**なのに拒否していた。spec に gh コマンドを引用するのはガバナンス系の周回では
 * 常態なので、自分の spec が組み立てられなくなる。
 *
 * コマンドの直後だけを見れば、両方とも正しく分かれる。
 */
const ROLE_WINDOW = 16;

/** しるしを探す窓を切り出す（最初の区切りか `ROLE_WINDOW` 文字まで）。 */
function roleWindow(sentence: string, afterIndex: number): string {
  const rest = sentence.slice(afterIndex, afterIndex + ROLE_WINDOW);
  const cut = rest.search(/[、。（(）)]/);
  return cut < 0 ? rest : rest.slice(0, cut);
}

/** 禁止文を骨抜きにしうる緩和表現（**網羅ではない**。warn どまりなのはそのため）。 */
const HEDGING = /(て|で)もよい|(て|で)も構いません|問題ありません|差し支え|可能なら|推奨します|任意/;

/** 文へ割る。`。` と改行の両方で切る（spec は箇条書きも書かれる）。 */
function sentences(text: string): string[] {
  return text
    .split(/[。\n]/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/**
 * 判定用に空白を潰す。`gh  pr  create` のような空白ゆれで素通りさせない（レビュー m-1）。
 * **原文は返り値へそのまま載せる**ので、人が直す手がかりは失わない。
 */
function normalize(text: string): string {
  return text.replace(/[ \t\u3000]+/g, ' ');
}

function inspectOne(field: FreeTextField, text: string, index?: number): FreeTextFinding[] {
  const findings: FreeTextFinding[] = [];
  for (const sentence of sentences(text)) {
    const probe = normalize(sentence);
    // **出現ごとに**見る。1 文に複数書かれたら、配っている方を名指しする（レビュー m-2）。
    let offending: string | undefined;
    for (const command of GRAPHQL_BOUND_COMMANDS) {
      for (let at = probe.indexOf(command); at >= 0; at = probe.indexOf(command, at + 1)) {
        if (!ALLOWED_ROLE.test(roleWindow(probe, at + command.length))) {
          offending = command;
          break;
        }
      }
      if (offending !== undefined) break;
    }
    if (offending !== undefined) {
      findings.push({
        field,
        ...(index === undefined ? {} : { index }),
        severity: 'reject',
        sentence,
        message:
          `\`${offending}\` を「禁じる」でも「観測を述べる」でもない文脈で書いています。` +
          `クラウドの routine セッションでは 403 になる観測があり、そのまま委譲先へ配ると 1 周回を失います` +
          `（#678 / #702）。PR 作成は \`scripts/create-pull-request.ts\`、マージは ` +
          `\`scripts/merge-pull-request.ts\`、照会は REST（\`gh api repos/...\`）を指示してください。` +
          `禁止・観測として**引用したいだけ**なら、コマンドの直後に理由を置いてください` +
          `（例: \`gh pr create\` は使わないこと / \`gh pr view\` が 403 でした）。`,
      });
      continue;
    }
    if (HEDGING.test(probe)) {
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
