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

/**
 * 強調記法・数値文字参照・セル内の余分な空白を落とす。表記のゆれで判定を変えない。
 *
 * 🔴 **`**` だけでは足りない。** `🔴 *素通り*`（斜体）や `&#9989;`（GitHub は ✅ として描画）で
 * 予約記号の検査を素通りできることをレビューが実測した。**描画されたときに読者が見る形**へ
 * 寄せてから判定する。
 */
function normalizeCell(raw: string): string {
  return raw
    .replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll('**', '')
    .replaceAll('*', '')
    .replaceAll('_', '')
    .replace(/<\/?[a-z][^>]*>/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function splitRow(line: string): ReadonlyArray<string> {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(normalizeCell);
}

/**
 * 区切り行。**先頭パイプは省略できる**（GFM）。`| --- | --- |` も `--- | ---` も表である。
 * 🔴 先頭パイプを要求すると、パイプ無しの表が丸ごと検査の外へ出る（レビュー実測）。
 */
const isSeparator = (line: string): boolean =>
  /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/u.test(line.trim());

/** 引用の `>` を剥がす。引用ブロックの中でも GitHub は表として描画する。 */
const stripQuote = (line: string): string => line.replace(/^\s*(?:>\s?)+/u, '');

/** 表の行とみなせるか。パイプを含んでいればよい（先頭パイプは必須ではない）。 */
const looksLikeRow = (line: string): boolean => line.includes('|');

/**
 * 先頭見出しが `firstHeader` の markdown 表を**全部**取り出す。
 *
 * 🔴 **1 枚目で打ち切らない。** 「見出しで特定する」だけでは足りず、**同じ見出しの表が
 * 2 枚あると、実際に読まれるのは 1 枚目で、本物が無検査になる**。しかも文書を分割した
 * ようにしか見えないので、レビューでも気づかれない。呼び出し側が「ちょうど 1 枚」を
 * 要求できるように、枚数を返す形にしてある（レビュー MAJOR-3 が実測: 正しい内容の複製を
 * 足して本物の Cognito 行を ✅ に書き換えると、検査は緑のままだった）。
 */
/**
 * 文書中の markdown 表を全部取り出す。
 *
 * 🔴 **「`|` で始まる行」を表の定義にしない。** レビューが 4 種の逃げ道を実測した ――
 * 先頭パイプ省略の表 / 引用ブロック内の表 / **見出し行**（`headers` を走査していなかった）/
 * コードフェンス内の表。読者に表として描画されるものは、検査にとっても表である。
 * 逆に**コードフェンスの中は表ではない**（「こう書くと落ちる」という否定例を書けなくなる）。
 */
export function parseAllMarkdownTables(markdown: string): ReadonlyArray<ParsedTable> {
  const raw = markdown.split('\n');
  // コードフェンスの中を落とす。行番号は保つため空行に置き換える。
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of raw) {
    const m = /^\s*(`{3,}|~{3,})/u.exec(stripQuote(line));
    if (fence === null && m) {
      fence = m[1]!.slice(0, 1);
      lines.push('');
      continue;
    }
    if (fence !== null) {
      if (m && m[1]!.startsWith(fence)) fence = null;
      lines.push('');
      continue;
    }
    lines.push(line);
  }

  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = stripQuote(lines[i] ?? '');
    if (!looksLikeRow(line)) continue;
    if (!isSeparator(stripQuote(lines[i + 1] ?? ''))) continue;
    const headers = splitRow(line);
    const rows: TableRow[] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = stripQuote(lines[j] ?? '');
      if (!looksLikeRow(row)) break;
      rows.push({ cells: splitRow(row), line: j + 1 });
    }
    tables.push({ headers, rows, headerLine: i + 1 });
  }
  return tables;
}

export function parseMarkdownTables(markdown: string, firstHeader: string): ReadonlyArray<ParsedTable> {
  return parseAllMarkdownTables(markdown).filter((t) => t.headers[0] === firstHeader);
}

/** 予約記号を許す表と、その表の中で許す列。`columns` 省略＝その表の全列で許す。 */
export type ReservedMarkAllowance = {
  readonly firstHeader: string;
  readonly columns?: ReadonlyArray<string>;
};

/**
 * **予約記号を書いてよい場所の正本**（#1114）。
 *
 * 🔴 **テスト側に置かない。** #1113 は `PROBE_CAPABILITIES` も語彙も `capability-doc.ts` へ
 * 集めた。ここをテストに置くと、**テスト 1 行の編集で逃げ道が全部再び開き、`src/` の diff には
 * 何も出ない**（レビュー指摘）。方針データは実装側に置き、テストは突き合わせるだけにする。
 *
 * 🔴 **キーの集合も数え上げではなく閉包で縛る。** 「素通り記号（`matrixMark('permissive')`）を
 * 含む `docs/` 配下の md は、全部このマップに載っていること」を検査する ―― 表・列の軸を
 * 許可の数え上げへ裏返しても、**ファイルの軸が数え上げのままなら 3 枚目で抜ける**。
 * 実際 ADR 0010 が 3 枚目として抜けており、matrix と矛盾していた（CloudFormation の Moto が
 * ADR では ✅、matrix では（未測））。
 */
export const RESERVED_MARK_SCOPE: Readonly<Record<string, ReadonlyArray<ReservedMarkAllowance>>> = {
  'docs/local-aws.md': [
    // 凡例は記号の**定義**。`記号` 列だけで、行は下の LEGEND_ROWS で有界にする。
    { firstHeader: '判定', columns: ['記号'] },
    // matrix は runtime 列だけ。`Notes` / `Real AWS 必須` では主張させない。
    { firstHeader: 'Service / 操作', columns: ['Moto', 'MiniStack'] },
  ],
  'docs/development/local-aws-sandbox.md': [
    { firstHeader: '能力', columns: ['MiniStack', 'Moto'] },
  ],
  // ADR は決定の記録。Cognito SRP の**素通り**は正確なので残し、過大主張だった ✅ は落とした。
  'docs/adr/0010-swappable-aws-emulator.md': [
    { firstHeader: '操作', columns: ['MiniStack', 'Moto'] },
  ],
};

/** 凡例表に在ってよい行ラベル。**無界にすると捏造した能力行を凡例へ足せる**（レビュー実測）。 */
export const LEGEND_ROWS: ReadonlyArray<string> = [
  ...CAPABILITY_VERDICTS.map((v) => `\`${v}\``),
  '（正の対照のみ）',
  '（未測）',
];

export type ReservedMarkViolation = {
  readonly tableFirstHeader: string;
  readonly column: string;
  readonly cell: string;
  readonly mark: string;
  readonly line: number;
};

/**
 * **予約記号（✅ / 🔴 素通り）は、許した表の許した列にしか現れてはならない。**
 *
 * 🔴 **なぜ列を足す形にしないか。** #1113 の検査は「検査対象 2 表の runtime 列」しか見て
 * おらず、レビューが**4 つの逃げ道**を実測した —— matrix の `Notes` 列 / `Real AWS 必須` 列 /
 * 別の表（`| 段 | 結果 |`）/ 別文書の 2 表。列を 2 つ足して塞ぐと、表を 1 枚足すだけで
 * また抜ける（`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」が言う
 * 「新方式向けの穴だけ塞いで族を見落とす」形）。**許す側を数え上げる**ことで族ごと閉じる。
 *
 * 🔴 **散文は対象外である。** 記号を**論じる**文（「当時は ✅ を付けていた」等）まで禁じると
 * 経緯を書けなくなる。危険なのは「verdict の主張に見えるセル」であって、記号への言及ではない。
 */
export function findReservedMarkViolations(input: {
  readonly markdown: string;
  readonly allow: ReadonlyArray<ReservedMarkAllowance>;
}): ReadonlyArray<ReservedMarkViolation> {
  const marks = NEGATIVE_CONTROL_ONLY_VERDICTS.map(matrixMark);
  const found: ReservedMarkViolation[] = [];
  for (const table of parseAllMarkdownTables(input.markdown)) {
    const first = table.headers[0] ?? '';
    const allowance = input.allow.find((a) => a.firstHeader === first);
    // 🔴 **見出しセルも走査する。** `| 段 | 結果（すべて ✅ 負の対照つき） |` のように
    // 見出しへ主張を書く逃げ道をレビューが実測した。見出しは常に列指定の外なので許さない。
    const scan = (cells: ReadonlyArray<string>, line: number, isHeader: boolean) => {
      cells.forEach((cell, index) => {
        const mark = marks.find((m) => cell.includes(m));
        if (mark === undefined) return;
        const column = isHeader ? `見出し${index + 1}` : (table.headers[index] ?? `列${index + 1}`);
        if (
          !isHeader &&
          allowance !== undefined &&
          (allowance.columns === undefined || allowance.columns.includes(column))
        ) {
          return;
        }
        found.push({ tableFirstHeader: first, column, cell, mark, line });
      });
    };
    scan(table.headers, table.headerLine, true);
    for (const row of table.rows) scan(row.cells, row.line, false);
  }

  // 🔴 **HTML 表は markdown の表パーサに掛からない。** `<td>✅ …</td>` で丸ごと外へ出られる。
  input.markdown.split('\n').forEach((line, index) => {
    if (!/<t[dh][\s>]/iu.test(line)) return;
    const mark = marks.find((m) => line.includes(m));
    if (mark === undefined) return;
    found.push({
      tableFirstHeader: '(html)',
      column: '(html cell)',
      cell: line.trim(),
      mark,
      line: index + 1,
    });
  });
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
