/**
 * 文書の compatibility matrix を、probe の**実測記録**と行ごとに突き合わせる（#1113）。
 *
 * ## なぜ要るか
 *
 * `docs/local-aws.md` の matrix と `docs/development/local-aws-sandbox.md` の証拠表は
 * **手で維持されており、機械が一切確かめていなかった**。#1103 / PR #1110 のレビューは
 * **6 周**にわたってセルが嘘であることを検出し続け、**うち 3 周は、直前の周が
 * 「この型を直すために」書き換えた表の中で再発している**。セルを直し続けるやり方は
 * 実測として機能していない ―― 人が転記する限りずれ、**ずれても誰も落ちない**からである。
 *
 * ## 何を前提にしないか
 *
 * 🔴 **エミュレータの稼働を前提にしない**（#1103 条件 5「既定のゲートを変えない」）。
 * 突き合わせる相手は `npm run aws:local:capability -- --json` の**記録済み出力**
 * （`docs/evidence/emulator-capability.*.json`）であって、probe の実行ではない。
 * probe をゲートで走らせるのは #1113 の非目標である。
 *
 * ## 何を縛るか
 *
 * 1. **記号 ≡ verdict**（行ごと・runtime ごと）。probe が測った行のセルは
 *    `matrixMark(verdict)` と一致しなければならない
 * 2. **裏付けの双方向**。probe が測る能力は全部表に在り、表が「負の対照つき」を
 *    立てた行は全部 probe が測っている
 * 3. **「未測」と「測って ✅」を記号で分ける**。負の対照なしでは到達できない verdict の
 *    記号（✅ / 🔴 素通り）は、probe の裏付けが無い行では使えない
 *
 * 🔴 **exit code は oracle にならない**（#1113 本文）。Cognito の `permissive` が単独で
 * probe の exit 1 を固定するので、DynamoDB 行が壊れても exit は変わらない。だから
 * verdict を**行ごとに**突き合わせる。
 *
 * ## 記録を取り直す
 *
 *     npm run aws:local:up && npm run --silent aws:local:capability -- --json \
 *       > docs/evidence/emulator-capability.ministack.json
 *     AWS_RUNTIME=moto npm run aws:local:up
 *     AWS_RUNTIME=moto npm run --silent aws:local:capability -- --json \
 *       > docs/evidence/emulator-capability.moto.json
 *
 * 🔴 **記録を手で書かない。** 手で書いた瞬間、この検査は「人が書いた 2 箇所の一致」に
 * 退化し、#1113 が直そうとしている型そのものへ戻る。
 */
import {
  CAPABILITY_VERDICTS,
  NEGATIVE_OUTCOMES,
  POSITIVE_OUTCOMES,
  classifyCapability,
  matrixMark,
  type CapabilityVerdict,
  type NegativeOutcome,
  type PositiveOutcome,
} from './emulator-capability';

/**
 * probe が実際に測る能力の名前。**`scripts/aws-local-capability.ts` はここを import する**
 * ので、probe が能力を足した／消したのに文書と記録が追随していなければ検査が落ちる。
 */
export const PROBE_CAPABILITIES = [
  'Cognito USER_SRP_AUTH（管理者ログイン）',
  'DynamoDB 条件付き作成（putIfAbsent の原子性）',
  'DynamoDB GSI テナント分離',
] as const;

export type ProbeCapability = (typeof PROBE_CAPABILITIES)[number];

/**
 * 能力名は probe と文書で一致していない（#1113 本文の対応表）。**マッピングを明示する**。
 * `Record<ProbeCapability, string>` なので、probe が能力を足すと型で落ちる。
 */
export const MATRIX_DOC_LABELS: Readonly<Record<ProbeCapability, string>> = {
  'Cognito USER_SRP_AUTH（管理者ログイン）': 'Cognito SRP のパスワード検証',
  'DynamoDB 条件付き作成（putIfAbsent の原子性）': 'DynamoDB 条件付き書き込み',
  'DynamoDB GSI テナント分離': 'DynamoDB GSI テナント分離',
};

/**
 * 各能力の**対照の説明**。probe（`scripts/aws-local-capability.ts`）はここから読み、
 * 記録の読み取りはここと一致することを要求する。
 *
 * 🔴 **何を検出できて、何を検出できないか。** probe は説明をここから読むので、probe が
 * 出した記録で説明が能力名と食い違うことは**構造的に起こらない**。この突き合わせが
 * 落とせるのは (a) 記録の手編集、(b) 測定が落ちたときの catch 経路、(c) ここの文言を
 * 変えたのに記録を取り直していない場合 ―― の 3 つである。
 *
 * **測定関数の対応の取り違え**（`Record` のキーと値を入れ替える）を実際に止めているのは
 * `scripts/aws-local-capability.ts` の実行時一致検査と、`parseRecording` の網羅検査
 * （取り違えると同じ能力が 2 件・別の能力が 0 件になる）である。**測定関数の本体そのものを
 * 入れ替える**型は、静的にも記録からも検出できない（人のレビューだけが守り）。
 * 1 周目のこのコメントは「唯一の紐」と書いていたが、それは実態より強い主張だった。
 *
 * **説明を変えたら記録を取り直すこと** —— 説明は「何を測ったか」なので、変わったなら記録は古い。
 */
export const CAPABILITY_CONTROLS: Readonly<
  Record<ProbeCapability, { readonly positiveDesc: string; readonly negativeDesc: string }>
> = {
  'Cognito USER_SRP_AUTH（管理者ログイン）': {
    positiveDesc: '正しいパスワードで ID トークンが出る',
    negativeDesc: '🔴 誤ったパスワードが拒否される',
  },
  'DynamoDB 条件付き作成（putIfAbsent の原子性）': {
    positiveDesc: '新規 id の作成が成功する',
    negativeDesc: '同じ id の二重作成が拒否される',
  },
  'DynamoDB GSI テナント分離': {
    positiveDesc: '自テナントの項目が index 越しに引ける',
    negativeDesc: '他テナントからは引けない',
  },
};

/** `docs/development/local-aws-sandbox.md` の証拠表は別の言い回しを使っている。 */
export const SANDBOX_DOC_LABELS: Readonly<Record<ProbeCapability, string>> = {
  'Cognito USER_SRP_AUTH（管理者ログイン）': 'Cognito SRP のパスワード検証',
  'DynamoDB 条件付き作成（putIfAbsent の原子性）': 'DynamoDB 条件付き作成（二重作成が拒否される）',
  'DynamoDB GSI テナント分離': 'DynamoDB GSI テナント分離（他テナントから引けない）',
};

/**
 * **負の対照なしでは到達できない** verdict。= その記号は probe の裏付けが無い行には書けない。
 *
 * 🔴 **手で並べない。判定関数から導出する。** `classifyCapability` を緩める変異
 * （例: 負が `unreachable` でも `verified` を返す）は、この一覧が痩せることで露見する ――
 * 「記号の予約」と「判定の規則」が同じ出どころを共有していることが要点である。
 */
export const NEGATIVE_CONTROL_ONLY_VERDICTS: ReadonlyArray<CapabilityVerdict> =
  CAPABILITY_VERDICTS.filter(
    (verdict) =>
      !POSITIVE_OUTCOMES.some(
        (positive) => classifyCapability({ positive, negative: 'unreachable' }) === verdict,
      ),
  );

/** 正の対照しか当てていない行の記号。「操作が通った」以上を主張しない。 */
export const POSITIVE_ONLY_MARK = '◯ 正のみ';

/** そもそも測っていない行の記号。 */
export const UNMEASURED_MARK = '（未測）';

export type TableRow = {
  readonly cells: ReadonlyArray<string>;
  /** 1 始まりの行番号。「どこか」ではなく「どの行」を言えるようにする。 */
  readonly line: number;
};

export type ParsedTable = {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<TableRow>;
  /** 見出し行の 1 始まり行番号。見出しセルの違反を指すために要る。 */
  readonly headerLine: number;
};

/** 強調記法とセル内の余分な空白を落とす。表記のゆれで判定を変えない。 */
function normalizeCell(raw: string): string {
  return raw.replaceAll('**', '').replace(/\s+/gu, ' ').trim();
}

function splitRow(line: string): ReadonlyArray<string> {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith('|') ? -1 : undefined)
    .split('|')
    .map(normalizeCell);
}

const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|?\s*$/u.test(line.trim());

/**
 * 文書中の markdown 表を全部取り出す。
 *
 * 🔴 **この関数は「予約記号を書いてよいか」の判定に使わない。** 一度そこへ使ったところ、
 * 区切り行の書式・引用・HTML・コードフェンスの扱いを足すたびに**別の綴りで突破され**、
 * しかも受理集合を狭める退行（単一ハイフンの区切り行を落とす）まで作った。
 * 判定は `findReservedMarkViolations`（出現の目録との完全一致）が持ち、ここは
 * **記録との突き合わせ（`reconcileCapabilityDoc`）専用**である。
 */
export function parseAllMarkdownTables(markdown: string): ReadonlyArray<ParsedTable> {
  const lines = markdown.split('\n');
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim().startsWith('|')) continue;
    if (!isSeparator(lines[i + 1] ?? '')) continue;
    const headers = splitRow(line);
    const rows: TableRow[] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = lines[j] ?? '';
      if (!row.trim().startsWith('|')) break;
      rows.push({ cells: splitRow(row), line: j + 1 });
    }
    tables.push({ headers, rows, headerLine: i + 1 });
  }
  return tables;
}

export function parseMarkdownTables(markdown: string, firstHeader: string): ReadonlyArray<ParsedTable> {
  return parseAllMarkdownTables(markdown).filter((t) => t.headers[0] === firstHeader);
}

/**
 * **予約記号を含んでよい行の目録**（#1114）。値は**正規化した行の全文**。
 *
 * ## なぜ「表の中か」で判定しないのか
 *
 * 最初は「予約記号は許した表の許した列にしか現れない」を markdown の表構造で判定していた。
 * それは**自前の GFM パーサを判定経路に置く**ことを意味し、レビューが 2 周で 5 つの穴を実測した
 * —— 先頭パイプ省略 / 引用ブロック / HTML 表（複数行）/ コードフェンスのスコープ /
 * **区切り行のハイフン 1 本**。最後のものは、広げたつもりで**受理集合を狭めた退行**だった。
 *
 * 綴りを足すたびに別の綴りで破られるのは `.claude/rules/opus5-autonomous-loop.md` の #813 と
 * 同型である。だから**方式を裏返した**: 構造を解釈せず、**予約記号が現れる行を全部列挙**し、
 * この目録と**完全一致**することを求める。区切り行の書式・引用・HTML・フェンス・実体参照の
 * どれも検出力に影響しない（パーサは違反の**説明**にしか使わない）。
 *
 * 🔴 **行を 1 文字でも変えたら、ここも変える必要がある。** それが狙いである ――
 * 予約記号を含む行は、能力の主張かその議論であり、**黙って書き換わってよい行ではない**。
 *
 * 🔴 **目録から項目を消したとき、何が守られ何が守られないか。** probe が裏付ける 3 行
 * （matrix と証拠表の能力行）は、消しても `reconcileCapabilityDoc` が `missing_row` 等で
 * 落とす（実測）。守られないのは **(a) 散文の行 (b) probe 非対象の行 (c) ファイル項目ごとの削除**
 * の 3 つだけで、(c) はキー集合の下界で閉じてある。残る (a)(b) は規約 7（テスト削除・弱体化で
 * green にしない）と同じ**規律**の領域 —— 削除は `src/` の diff に必ず出るので、レビューで見る。
 *
 * 🔴 **空配列は「この文書に予約記号が 1 つも在ってはならない」を意味する。**
 * 転記先を減らすために記号を消した文書（ADR 0010）は、記号が無いというだけで検査対象から
 * 外れると、**そこへ書き戻す経路が静かに開く**（変異検証で実測）。消したうえで**ゼロを固定する**。
 *
 * 🔴 **目録は現在の文書から生成した。だから「今在る主張が正しい」ことは保証しない。**
 * 保証するのは「**黙って増えない・黙って消えない**」だけである。主張の真偽は
 * `reconcileCapabilityDoc`（記録との突き合わせ）が matrix と証拠表について担保する。
 */
/** 凡例表に在ってよい行ラベル。**無界にすると捏造した能力行を凡例へ足せる**（レビュー実測）。 */
export const LEGEND_ROWS: ReadonlyArray<string> = [
  ...CAPABILITY_VERDICTS.map((v) => `\`${v}\``),
  '（正の対照のみ）',
  UNMEASURED_MARK,
];

export type ScopeGap =
  | { readonly kind: 'file_not_in_scope'; readonly file: string }
  | { readonly kind: 'scope_file_without_mark'; readonly file: string }
  | { readonly kind: 'legend_rows_changed'; readonly actual: ReadonlyArray<string> };

/** 閉包の鍵。**`✅` は使えない**（`SCOPE_KEY_MARK` の注記を読むこと）。 */
export const SCOPE_KEY_MARK = matrixMark('permissive');

/**
 * 予約記号を持つ文書の集合と、目録の対象ファイルが**一致する**こと。
 *
 * 🔴 **鍵に `✅` を使えない。** レビューは「片側の鍵は片側の閉包しか作らない」と指摘し、
 * それ自体は正しい。だが実測すると **`✅` はこのリポジトリで「済み」の汎用記号**であり、
 * `docs/` と `.claude/rules/` の **13 文書・100 行超**が能力とは無関係に使っている
 * （`docs/runbook-cloud-aws-deploy.md` 33 行 / `docs/scope.md` 19 行 /
 * `docs/component-catalog.md` 17 行 / `docs/loop-queue.md` 15 行 …）。
 * `✅` を鍵にすると、それら全部を目録へ取り込むか除外一覧を手で維持するかになり、
 * **どちらも能力の主張とは関係ないところで壊れる**。
 *
 * よって鍵は `🔴 素通り`（能力 verdict にしか現れない綴り）に限る。
 * 🔴 **鍵で引くときは正規化してから引くこと。** 生文字列で引くと、このリポジトリの正準表記
 * `🔴 **素通り**`（太字）に**一度も一致しない** —— 既存 matrix からコピーして新しい文書を作る
 * という最も自然な作り方が、閉包を素通りする（レビュー実測）。
 * 🔴 **残る穴**: `✅` だけで能力を主張する**新しい**文書は、この閉包に入らない。
 * 目録の対象 3 文書の中では `✅` も完全に縛られているが、外は縛れていない。
 */
export function findScopeGaps(input: {
  readonly carriers: ReadonlyArray<string>;
  /** ファイル -> 目録。**空配列は「記号ゼロを固定する」**意味なので carrier でなくてよい。 */
  readonly scope: Readonly<Record<string, ReadonlyArray<string>>>;
}): ReadonlyArray<ScopeGap> {
  const gaps: ScopeGap[] = [];
  const files = Object.keys(input.scope);
  for (const file of input.carriers) {
    if (!files.includes(file)) gaps.push({ kind: 'file_not_in_scope', file });
  }
  for (const file of files) {
    // 空目録のファイルは「記号が無いこと」を固定する対象なので、carrier でなくて当然。
    if ((input.scope[file] ?? []).length === 0) continue;
    if (!input.carriers.includes(file)) gaps.push({ kind: 'scope_file_without_mark', file });
  }
  return gaps;
}

/** 凡例の行が導出値ぴったりであること。 */
export function findLegendRowGaps(rowLabels: ReadonlyArray<string>): ReadonlyArray<ScopeGap> {
  const same =
    rowLabels.length === LEGEND_ROWS.length && rowLabels.every((l, i) => l === LEGEND_ROWS[i]);
  return same ? [] : [{ kind: 'legend_rows_changed', actual: rowLabels }];
}

export const RESERVED_MARK_INVENTORY: Readonly<Record<string, ReadonlyArray<string>>> = {
  'docs/local-aws.md': [
    'トークンを発行しており、「正しいパスワードで通る」だけを見た判定が ✅ を付けていた。',
    '| `verified` | ✅ | 正は通り、負は拒否された。ローカルの緑に意味がある |',
    '| `permissive` | 🔴 素通り | 正も負も通る。緑のまま嘘をつく ―― `unavailable` より危険 |',
    '🔴 機械が予約しているのは ✅ と 🔴 素通り の 2 つだけである。 この 2 つは負の対照を',
    'これが「まだ測っていない」と「測って ✅ だった」の区別で、凡例ではなく記号が担う',
    '🔴 下表で ✅ が付いているのは、負の対照まで当てた 3 行だけである。 `◯ 正のみ` の行は',
    '負の対照を足すこと（足せば ✅ になり、記録と表が同時に動く）。',
    '🔴 この 3 文書では、予約記号（✅ と 🔴 素通り）が現れる行が機械で固定してある（#1114）',
    '🔴 この保証は上の 3 文書に閉じている。 `✅` はこのリポジトリで「済み」の汎用記号として',
    '13 文書・100 行超が使っており、鍵にできない。新しい文書で `✅` だけを使って能力を主張する',
    '経路は縛れていない（閉包の鍵は `🔴 素通り` のみ）。能力の主張は下表と証拠表にしか書かないこと。',
    '| DynamoDB 条件付き書き込み | ✓ | ✅ | ✅ | — | `putIfAbsent` / CAS。二重作成が拒否されることまで実測 |',
    '| DynamoDB GSI テナント分離 | ✓ | ✅ | ✅ | — | 他テナントから引けないことまで実測 |',
    '| Cognito SRP のパスワード検証 | ✓ | 🔴 素通り | 🔴 素通り | 必須 | 下記「Cognito は素通りする」 |',
  ],
  // 🔴 記号を消した文書。**ゼロであること**を固定する（書き戻す経路を塞ぐ）。
  'docs/adr/0010-swappable-aws-emulator.md': [],
  'docs/development/local-aws-sandbox.md': [
    '🔴 この文書では、✅ / 🔴 素通り を含む行が機械で固定してある（`RESERVEDMARKINVENTORY`。',
    '| DynamoDB 条件付き作成（二重作成が拒否される） | ✅ verified | ✅ verified |',
    '| DynamoDB GSI テナント分離（他テナントから引けない） | ✅ verified | ✅ verified |',
    '| Cognito SRP のパスワード検証 | 🔴 素通り | 🔴 素通り |',
  ],
};

export type ReservedMarkViolation = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly mark: string;
  /** `unblessed` = 目録に無い出現 / `missing` = 目録に在るのに文書から消えた行。 */
  readonly kind: 'unblessed' | 'missing';
};

/**
 * 予約記号の検出用の正規化。**描画されたときに読者が見る形**へ寄せる。
 * 実体参照・装飾・HTML タグで綴りを変える族（#813 と同型）を潰す。
 * 🔴 表のラベル一致（`normalizeCell`）とは**別の関数**にしてある ―― あちらを装飾剥がしに
 * すると、ラベルに `*` や `<T>` を含む行が静かに一致しなくなる（レビュー MINOR-5）。
 */
export function normalizeForMarkScan(raw: string): string {
  return (
    raw
      // 🔴 **タグ除去が先。** 実体参照を先に復号すると、`&#60;span …&#62;` が `<span …>` へ化けて
      // タグとして除去され、**レンダラには見えているテキスト**が祝福済み行と一致してしまう
      // （レビュー実測）。実体で書いたものは可視テキストなので、除去の対象ではない。
      //
      // 🔴 **`[^>\n]` —— 改行をまたがせない。** `[^>]` は改行に一致するので、`<<EOF` のように
      // 同じ行に `>` が無い綴りから**次の `>` までを全部消す**。実測で 1 文書が 878 文字・28 行を
      // 飲み込んでおり、ヒアドキュメントを含む手順書が**無音で検査の外へ出ていた**。
      .replace(/<\/?[a-z][^>\n]*>/giu, '')
      .replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/giu, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replaceAll('&nbsp;', ' ')
      .replaceAll('*', '')
      .replaceAll('_', '')
      // ゼロ幅文字は描画されないので、綴りを変える手段になる。
      .replace(/[\u200b-\u200d\ufeff]/gu, '')
      // `\s` は NBSP(U+00A0) を含む（実測）。`[\s\u00a0]` と書くと「NBSP を別途処理している」
      // という誤った印象を与えるだけで、振る舞いは同じ（等価変異として変異検証で確認済み）。
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

/**
 * 記号の照合は**空白に依存しない**。`🔴素通り`（空白なし）やゼロ幅で分断した綴りは
 * 描画上まったく区別が付かないので、検出側で吸収する（レビュー実測）。
 * 🔴 目録との**一致**には使わない —— あちらは読める形（空白を 1 つに畳んだ行）で比べる。
 */
const withoutSpaces = (t: string): string => t.replace(/\s/gu, '');

export function containsMark(text: string, mark: string): boolean {
  return withoutSpaces(text).includes(withoutSpaces(mark));
}

/** その行が含む予約記号（無ければ undefined）。 */
export function reservedMarkIn(line: string): string | undefined {
  const normalized = normalizeForMarkScan(line);
  return NEGATIVE_CONTROL_ONLY_VERDICTS.map(matrixMark).find((m) => containsMark(normalized, m));
}

/**
 * 文書の予約記号の出現が、目録と**完全一致**すること。
 *
 * 🔴 **両側を主張する。** 目録に無い出現（新しい主張が勝手に入った）と、目録に在るのに
 * 消えた行（主張が黙って落ちた）の**どちらも**報告する。片側だけだと、全部消せば通る。
 */
export function findReservedMarkViolations(input: {
  readonly file: string;
  readonly markdown: string;
  readonly inventory: ReadonlyArray<string>;
}): ReadonlyArray<ReservedMarkViolation> {
  const found: ReservedMarkViolation[] = [];
  // 🔴 **集合ではなく多重集合で数える。** `Set` と「所属するか」で判定していたときは、
  // **祝福済みの行をそっくり別の節へ複製しても無検出**だった（レビュー実測。しかも
  // 構造 allowlist 方式はこれを kill していた＝方式交換で kill を落としていた）。
  // 「黙って増えない」を主張する以上、**回数**を見なければ嘘になる。
  const budget = new Map<string, number>();
  for (const text of input.inventory) budget.set(text, (budget.get(text) ?? 0) + 1);

  input.markdown.split('\n').forEach((raw, index) => {
    const mark = reservedMarkIn(raw);
    if (mark === undefined) return;
    const text = normalizeForMarkScan(raw);
    const left = budget.get(text) ?? 0;
    if (left <= 0) {
      // 目録に無い行、または**目録の回数を超えた複製**。
      found.push({ file: input.file, line: index + 1, text, mark, kind: 'unblessed' });
      return;
    }
    budget.set(text, left - 1);
  });

  for (const [text, left] of budget) {
    for (let i = 0; i < left; i += 1) {
      found.push({
        file: input.file,
        line: 0,
        text,
        mark: reservedMarkIn(text) ?? '',
        kind: 'missing',
      });
    }
  }
  return found;
}

export type CapabilityRecording = {
  readonly runtime: string;
  readonly measuredAt: string;
  readonly results: ReadonlyArray<{
    readonly capability: ProbeCapability;
    readonly positive: PositiveOutcome;
    readonly negative: NegativeOutcome;
    readonly verdict: CapabilityVerdict;
  }>;
};

const isVerdict = (v: unknown): v is CapabilityVerdict =>
  CAPABILITY_VERDICTS.includes(v as CapabilityVerdict);

const isProbeCapability = (v: unknown): v is ProbeCapability =>
  PROBE_CAPABILITIES.includes(v as ProbeCapability);

const isPositive = (v: unknown): v is PositiveOutcome =>
  POSITIVE_OUTCOMES.includes(v as PositiveOutcome);

const isNegative = (v: unknown): v is NegativeOutcome =>
  NEGATIVE_OUTCOMES.includes(v as NegativeOutcome);

/**
 * probe の `--json` 出力を読む。**知らない値を受け流さない。**
 *
 * 🔴 記録が手で編集されて `"verdict": "ok"` のような値が入ったとき、黙って
 * 「一致しなかった」ではなく**読めない**として落とす。判定できない記録を
 * 「判定に使えた」と読まないため（`emulator-capability.ts` の `inconclusive` と同じ姿勢）。
 */
export function parseRecording(raw: unknown): CapabilityRecording {
  const obj = raw as Record<string, unknown> | null;
  if (typeof obj !== 'object' || obj === null) throw new Error('記録が object ではない');
  const { runtime, measuredAt, results } = obj;
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new Error('記録に runtime が無い');
  }
  if (typeof measuredAt !== 'string' || measuredAt.length === 0) {
    throw new Error(`記録に measuredAt が無い (runtime=${runtime})`);
  }
  if (!Array.isArray(results)) throw new Error(`記録に results が無い (runtime=${runtime})`);
  const parsed = results.map((entry) => {
    const { capability, verdict, positive, negative, positiveDesc, negativeDesc } = (entry ??
      {}) as Record<string, unknown>;
    if (!isProbeCapability(capability)) {
      throw new Error(
        `probe が測らない capability が記録にある: ${String(capability)} (runtime=${runtime})`,
      );
    }
    if (!isVerdict(verdict)) {
      throw new Error(`知らない verdict: ${String(verdict)} (${capability} / runtime=${runtime})`);
    }
    if (!isPositive(positive) || !isNegative(negative)) {
      throw new Error(
        `知らない対照の結果: positive=${String(positive)} negative=${String(negative)} ` +
          `(${capability} / runtime=${runtime})`,
      );
    }
    // 🔴 **記録は自分自身と整合していなければならない。** `verdict` だけを書き換える改竄が
    // 最も安い（文字列 1 個）。生データ（`positive`/`negative`）から判定を導き直して照合する
    // ことで、嘘をつくには 2 箇所を整合させる必要が生じる。判定規則は `classifyCapability`
    // が唯一の出どころなので、ここでも再実装しない。
    const derived = classifyCapability({ positive, negative });
    if (derived !== verdict) {
      throw new Error(
        `記録の verdict が測定値と整合しない (${capability} / runtime=${runtime}): ` +
          `positive=${positive} negative=${negative} なら ${derived} のはずだが ${verdict} と書いてある`,
      );
    }
    // 🔴 **何を測ったかの説明が probe と一致していること。** ここが probe と記録を結ぶ紐で、
    // 測定関数の取り違え（能力 A の記録に能力 B の測定が入る）を記録側から検出できる唯一の手段。
    const controls = CAPABILITY_CONTROLS[capability];
    if (positiveDesc !== controls.positiveDesc || negativeDesc !== controls.negativeDesc) {
      throw new Error(
        `記録の対照の説明が probe と一致しない (${capability} / runtime=${runtime}): ` +
          `記録=[${String(positiveDesc)} / ${String(negativeDesc)}] ` +
          `probe=[${controls.positiveDesc} / ${controls.negativeDesc}]。記録を取り直すこと`,
      );
    }
    return { capability, positive, negative, verdict };
  });
  // 🔴 probe は必ず全能力を 1 件ずつ出す（落ちた測定も `inconclusive` として入る）。
  // 欠けている記録は「測っていない」ではなく**記録が壊れている**ので、突き合わせに使わない。
  const missing = PROBE_CAPABILITIES.filter((c) => !parsed.some((r) => r.capability === c));
  if (missing.length > 0) {
    throw new Error(`記録に capability が欠けている (runtime=${runtime}): ${missing.join(' / ')}`);
  }
  // 🔴 **重複も拒否する。** `reconcile` は `find` で先勝ちに読むので、重複を許すと
  // 2 件目が無検査になる ―― `duplicate_table` / `duplicate_runtime_recording` で
  // 「先勝ちは片方を無検査にする」と拒否しておきながら、ここだけ許すのは非対称である。
  const duplicated = PROBE_CAPABILITIES.filter(
    (c) => parsed.filter((r) => r.capability === c).length > 1,
  );
  if (duplicated.length > 0) {
    throw new Error(`記録に capability が重複している (runtime=${runtime}): ${duplicated.join(' / ')}`);
  }
  return { runtime, measuredAt, results: parsed };
}

export type DiscrepancyKind =
  /** 表が見つからない（見出しが変わった／表ごと消えた）。 */
  | 'table_not_found'
  /** 同じ見出しの表が複数ある（どれが正本か決まらない）。 */
  | 'duplicate_table'
  /** runtime 列の見出しが表に無い（列ごと消えた／改名された）。 */
  | 'missing_column'
  /** 同じ runtime の記録が複数ある。 */
  | 'duplicate_runtime_recording'
  /** runtime 列に対応する記録が無い。 */
  | 'missing_runtime_recording'
  /** probe が測っている能力の行が表に無い。 */
  | 'missing_row'
  /** 記録にその能力の測定が無い（記録が壊れている。`parseRecording` を通していれば起きない）。 */
  | 'missing_measurement'
  /** probe の裏付けが無いのに「負の対照つき」を主張している。 */
  | 'unbacked_negative_control'
  /** probe が測っているのに「負の対照つき」の印が無い（未測と区別できない）。 */
  | 'unmarked_backed_row'
  /** 記号が実測の verdict と食い違う。 */
  | 'mark_mismatch'
  /** probe の裏付けが無い行が、負の対照なしでは書けない記号を使っている。 */
  | 'reserved_mark_outside_probe'
  /** probe の裏付けが無い行が、語彙に無い記号を使っている。 */
  | 'unknown_mark';

export type Discrepancy = {
  readonly kind: DiscrepancyKind;
  readonly message: string;
  readonly line?: number;
};

/**
 * probe の裏付けが無い行のセルに許される記号。**ホワイトリストである。**
 *
 * 🔴 **ブラックリスト（予約記号との完全一致）では足りない。** `✅ 実測` のように
 * **装飾を 1 文字足すだけ**で「未測の行に ✅」が通ってしまう ―― レビュー 2 周目が実測した
 * （`| DynamoDB TTL | | ✅ 実測 | ✅ 実測 |` で検査は緑のままだった）。これは
 * `.claude/rules/opus5-autonomous-loop.md` の #813 と同型（綴りを足して突破される族）で、
 * 「使える記号を数え上げる」側に倒さないと塞がらない。
 *
 * 末尾の補足は許す（`⛔ 405` のように「なぜ使えないか」を書きたい行が実在する）ので
 * **前方一致**で判定する。逆に、予約記号を**含む**セルは補足があっても弾く。
 */
function unbackedMarkVocabulary(): ReadonlyArray<string> {
  return [
    POSITIVE_ONLY_MARK,
    UNMEASURED_MARK,
    ...CAPABILITY_VERDICTS.filter((v) => !NEGATIVE_CONTROL_ONLY_VERDICTS.includes(v)).map(matrixMark),
  ];
}

/** セルが verdict を主張しているとみなせる表記（記号のみ / 記号 + verdict 名）。 */
function acceptedCells(verdict: CapabilityVerdict): ReadonlyArray<string> {
  const mark = matrixMark(verdict);
  return [mark, `${mark} ${verdict}`];
}

/**
 * 表と記録を突き合わせる。**見つかった食い違いを全部返す**（最初の 1 件で止めない）。
 *
 * `negativeControlColumn` を省いた表は、**全行が probe の裏付けを要求される**
 * （証拠表がその形。機械が測っていない行をそこへ書けない）。
 */
export function reconcileCapabilityDoc(input: {
  /** 見出しが一致した表**全部**。ちょうど 1 枚でなければ突き合わせない。 */
  readonly tables: ReadonlyArray<ParsedTable>;
  readonly labels: Readonly<Record<ProbeCapability, string>>;
  readonly recordings: ReadonlyArray<CapabilityRecording>;
  /** runtime 名 -> 列見出し。 */
  readonly runtimeColumns: Readonly<Record<string, string>>;
  readonly negativeControlColumn?: string;
}): ReadonlyArray<Discrepancy> {
  const { tables, labels, recordings, runtimeColumns, negativeControlColumn } = input;
  if (tables.length === 0) {
    return [{ kind: 'table_not_found', message: '突き合わせる表が見つからない' }];
  }
  if (tables.length > 1) {
    // 🔴 どれを読むか**選ばない**。選べば、選ばれなかったほうが無検査になる。
    return [
      {
        kind: 'duplicate_table',
        message: `同じ見出しの表が ${tables.length} 枚ある。正本を 1 枚にすること`,
      },
    ];
  }
  const table = tables[0]!;
  const found: Discrepancy[] = [];

  const cellAt = (row: TableRow, header: string): string => {
    const index = table.headers.indexOf(header);
    return index < 0 ? '' : (row.cells[index] ?? '');
  };

  // 🔴 **列ごと消えた／改名された**のを「セルが空」として報告しない。直す人が
  // 列ではなくセルを見に行ってしまう（レビュー MINOR-3）。
  for (const header of Object.values(runtimeColumns)) {
    if (!table.headers.includes(header)) {
      found.push({ kind: 'missing_column', message: `列 ${header} が表に無い` });
    }
  }
  if (
    negativeControlColumn !== undefined &&
    !table.headers.includes(negativeControlColumn)
  ) {
    found.push({ kind: 'missing_column', message: `列 ${negativeControlColumn} が表に無い` });
  }

  // runtime 列ごとに記録を引く。記録が無い列は**比較しない**（「一致した」に倒さない）。
  const byRuntime = new Map<string, CapabilityRecording>();
  for (const [runtime, header] of Object.entries(runtimeColumns)) {
    const matches = recordings.filter((r) => r.runtime === runtime);
    if (matches.length > 1) {
      // 先勝ちで片方を無視すると、**無視されたほうが無検査になる**。
      found.push({
        kind: 'duplicate_runtime_recording',
        message: `${runtime} の記録が ${matches.length} 件ある`,
      });
      continue;
    }
    const recording = matches[0];
    if (recording === undefined) {
      found.push({
        kind: 'missing_runtime_recording',
        message: `列 ${header} に対応する ${runtime} の実測記録が無い`,
      });
      continue;
    }
    byRuntime.set(runtime, recording);
  }

  const capabilityByLabel = new Map<string, ProbeCapability>(
    PROBE_CAPABILITIES.map((capability) => [labels[capability], capability]),
  );
  const seen = new Set<ProbeCapability>();

  for (const row of table.rows) {
    const label = row.cells[0] ?? '';
    const capability = capabilityByLabel.get(label);
    // 負の対照列が無い表では、全行が裏付けを主張しているものとして扱う。
    const claimsNegativeControl =
      negativeControlColumn === undefined ? true : cellAt(row, negativeControlColumn).length > 0;

    if (capability === undefined) {
      if (claimsNegativeControl) {
        found.push({
          kind: 'unbacked_negative_control',
          line: row.line,
          message: `「${label}」は負の対照つきと書いてあるが、probe は測っていない`,
        });
      }
      // probe の裏付けが無い行は、負の対照なしでは書けない記号を使えない。
      for (const header of Object.values(runtimeColumns)) {
        const cell = cellAt(row, header);
        // 🔴 **含んでいたら弾く。** 完全一致だと `✅ 実測` が素通りする。
        const reserved = NEGATIVE_CONTROL_ONLY_VERDICTS.find((verdict) =>
          cell.includes(matrixMark(verdict)),
        );
        if (reserved !== undefined) {
          found.push({
            kind: 'reserved_mark_outside_probe',
            line: row.line,
            message:
              `「${label}」の ${header} が ${cell}（= ${reserved} の記号を含む）と書いてあるが、` +
              `この記号は負の対照を当てた行にしか使えない。正の対照だけなら ${POSITIVE_ONLY_MARK}、` +
              `測っていないなら ${UNMEASURED_MARK}`,
          });
          continue;
        }
        // 🔴 **語彙の外は「知らない主張」として落とす。** 予約記号の一覧を守るだけでは、
        // 新しい記号を発明して同じ過大主張を書ける。
        if (!unbackedMarkVocabulary().some((mark) => cell.startsWith(mark))) {
          found.push({
            kind: 'unknown_mark',
            line: row.line,
            message:
              `「${label}」の ${header} が ${cell === '' ? '（空）' : cell} と書いてあるが、` +
              `probe の裏付けが無い行で使えるのは ${unbackedMarkVocabulary().join(' / ')} のいずれかで始まる記号だけ`,
          });
        }
      }
      continue;
    }

    seen.add(capability);
    if (!claimsNegativeControl) {
      found.push({
        kind: 'unmarked_backed_row',
        line: row.line,
        message: `「${label}」は probe が負の対照つきで測っているのに、その印が無い`,
      });
    }
    for (const [runtime, header] of Object.entries(runtimeColumns)) {
      const recording = byRuntime.get(runtime);
      if (recording === undefined) continue;
      const verdict = recording.results.find((r) => r.capability === capability)?.verdict;
      if (verdict === undefined) {
        // 🔴 **黙って飛ばさない。** `parseRecording` を通した記録なら全能力が揃っている
        // （そちらが保証する）。揃っていない記録がここへ来たということは、記録を
        // 組み立てた側が壊れている ―― それを `continue` で畳むと、**測っていない行が
        // 「一致した」として緑になる**。表の検査としては最悪の外し方である。
        found.push({
          kind: 'missing_measurement',
          line: row.line,
          message: `${runtime} の記録に「${capability}」の測定が無い`,
        });
        continue;
      }
      const cell = cellAt(row, header);
      if (!acceptedCells(verdict).includes(cell)) {
        found.push({
          kind: 'mark_mismatch',
          line: row.line,
          message:
            `「${label}」の ${header} は ${cell === '' ? '（空）' : cell} と書いてあるが、` +
            `${recording.measuredAt} の実測は ${verdict}（${matrixMark(verdict)}）`,
        });
      }
    }
  }

  for (const capability of PROBE_CAPABILITIES) {
    if (seen.has(capability)) continue;
    found.push({
      kind: 'missing_row',
      message: `probe が測っている「${capability}」の行（${labels[capability]}）が表に無い`,
    });
  }

  return found;
}
