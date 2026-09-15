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
  POSITIVE_OUTCOMES,
  classifyCapability,
  matrixMark,
  type CapabilityVerdict,
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
 * 先頭見出しが `firstHeader` の markdown 表を 1 つ取り出す。
 *
 * 🔴 **見出しで特定する。** 文書には表が何枚もあり（凡例・Tier・診断…）、
 * 「最初の表」や「見出しからの相対位置」で拾うと、表を 1 枚足しただけで別の表を
 * 検査しはじめる ―― しかも**静かに緑のまま**になる。
 */
export function parseMarkdownTable(markdown: string, firstHeader: string): ParsedTable | null {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim().startsWith('|')) continue;
    const headers = splitRow(line);
    if (headers[0] !== firstHeader) continue;
    if (!isSeparator(lines[i + 1] ?? '')) continue;
    const rows: TableRow[] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = lines[j] ?? '';
      if (!row.trim().startsWith('|')) break;
      rows.push({ cells: splitRow(row), line: j + 1 });
    }
    return { headers, rows };
  }
  return null;
}

export type CapabilityRecording = {
  readonly runtime: string;
  readonly measuredAt: string;
  readonly results: ReadonlyArray<{
    readonly capability: ProbeCapability;
    readonly verdict: CapabilityVerdict;
  }>;
};

const isVerdict = (v: unknown): v is CapabilityVerdict =>
  CAPABILITY_VERDICTS.includes(v as CapabilityVerdict);

const isProbeCapability = (v: unknown): v is ProbeCapability =>
  PROBE_CAPABILITIES.includes(v as ProbeCapability);

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
    const { capability, verdict } = (entry ?? {}) as Record<string, unknown>;
    if (!isProbeCapability(capability)) {
      throw new Error(
        `probe が測らない capability が記録にある: ${String(capability)} (runtime=${runtime})`,
      );
    }
    if (!isVerdict(verdict)) {
      throw new Error(`知らない verdict: ${String(verdict)} (${capability} / runtime=${runtime})`);
    }
    return { capability, verdict };
  });
  // 🔴 probe は必ず全能力を 1 件ずつ出す（落ちた測定も `inconclusive` として入る）。
  // 欠けている記録は「測っていない」ではなく**記録が壊れている**ので、突き合わせに使わない。
  const missing = PROBE_CAPABILITIES.filter((c) => !parsed.some((r) => r.capability === c));
  if (missing.length > 0) {
    throw new Error(`記録に capability が欠けている (runtime=${runtime}): ${missing.join(' / ')}`);
  }
  return { runtime, measuredAt, results: parsed };
}

export type DiscrepancyKind =
  /** 表が見つからない（見出しが変わった／表ごと消えた）。 */
  | 'table_not_found'
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
  | 'reserved_mark_outside_probe';

export type Discrepancy = {
  readonly kind: DiscrepancyKind;
  readonly message: string;
  readonly line?: number;
};

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
  readonly table: ParsedTable | null;
  readonly labels: Readonly<Record<ProbeCapability, string>>;
  readonly recordings: ReadonlyArray<CapabilityRecording>;
  /** runtime 名 -> 列見出し。 */
  readonly runtimeColumns: Readonly<Record<string, string>>;
  readonly negativeControlColumn?: string;
}): ReadonlyArray<Discrepancy> {
  const { table, labels, recordings, runtimeColumns, negativeControlColumn } = input;
  if (table === null) {
    return [{ kind: 'table_not_found', message: '突き合わせる表が見つからない' }];
  }
  const found: Discrepancy[] = [];

  /** 列見出し -> index。見出しが無ければ -1（セルは '' として扱われる）。 */
  const columnIndex = (header: string): number => table.headers.indexOf(header);
  const cellAt = (row: TableRow, header: string): string => {
    const index = columnIndex(header);
    return index < 0 ? '' : (row.cells[index] ?? '');
  };

  // runtime 列ごとに記録を引く。記録が無い列は**比較しない**（「一致した」に倒さない）。
  const byRuntime = new Map<string, CapabilityRecording>();
  for (const [runtime, header] of Object.entries(runtimeColumns)) {
    const recording = recordings.find((r) => r.runtime === runtime);
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
        const reserved = NEGATIVE_CONTROL_ONLY_VERDICTS.find((verdict) =>
          acceptedCells(verdict).includes(cell),
        );
        if (reserved !== undefined) {
          found.push({
            kind: 'reserved_mark_outside_probe',
            line: row.line,
            message:
              `「${label}」の ${header} が ${cell}（= ${reserved}）と書いてあるが、` +
              `この記号は負の対照を当てた行にしか使えない。正の対照だけなら ${POSITIVE_ONLY_MARK}、` +
              `測っていないなら ${UNMEASURED_MARK}`,
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
