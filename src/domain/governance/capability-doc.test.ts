import { describe, expect, it } from 'vitest';
import {
  MATRIX_DOC_LABELS,
  NEGATIVE_CONTROL_ONLY_VERDICTS,
  POSITIVE_ONLY_MARK,
  PROBE_CAPABILITIES,
  UNMEASURED_MARK,
  CAPABILITY_CONTROLS,
  parseMarkdownTables,
  parseRecording,
  reconcileCapabilityDoc,
  type CapabilityRecording,
  type ProbeCapability,
} from './capability-doc';
import { CAPABILITY_VERDICTS, matrixMark } from './emulator-capability';

/**
 * 文書の表と probe の実測を**行ごとに**突き合わせる（#1113）。
 *
 * ## なぜ要るか
 *
 * #1103 / PR #1110 のレビューは **6 周**にわたって「表のセルが嘘である」ことを検出し続け、
 * **うち 3 周は、直前の周が「この型を直すために」書き換えた表の中で再発した**。
 * セルを直し続けるアプローチは実測として機能していない。人が転記する限り必ずずれ、
 * **ずれても誰も落ちない**のが原因である。
 *
 * ここで縛るのは「人が書いた記号」と「機械が測った verdict」の一致であって、
 * 文章の言い回しではない（`tests/config/loop-round-skill.test.ts` と同じ型）。
 */

/** verdict から、それを生む測定値を逆に作る（記録は自己整合していなければ読めない）。 */
const OUTCOMES: Record<string, { positive: string; negative: string }> = {
  verified: { positive: 'passed', negative: 'rejected' },
  permissive: { positive: 'passed', negative: 'accepted' },
  unavailable: { positive: 'failed', negative: 'rejected' },
  inconclusive: { positive: 'unreachable', negative: 'unreachable' },
};

const entry = (capability: string, verdict: string, over: Record<string, unknown> = {}) => ({
  capability,
  ...(OUTCOMES[verdict] ?? { positive: 'passed', negative: 'rejected' }),
  verdict,
  // `as never` で索引エラーを黙らせない（規約 7「型安全性低下で green にしない」）。
  // 知らない能力名のケースを実際に作るので、`?? {}` で実行時の undefined も明示する。
  ...(CAPABILITY_CONTROLS[capability as ProbeCapability] ?? {}),
  ...over,
});

const REC = (runtime: string, verdicts: Record<string, string>): CapabilityRecording =>
  parseRecording({
    runtime,
    measuredAt: '2026-09-15T09:14:59.522Z',
    results: Object.entries(verdicts).map(([capability, verdict]) => entry(capability, verdict)),
  });

/** 実物と同じ形の最小の matrix。probe が測る 2 行 + 測っていない 1 行。 */
const table = (rows: string) =>
  parseMarkdownTables(
    ['| Service / 操作 | 負の対照 | Moto | MiniStack | Notes |', '| --- | --- | --- | --- | --- |', rows].join(
      '\n',
    ),
    'Service / 操作',
  );

const COGNITO = PROBE_CAPABILITIES[0];
const COND = PROBE_CAPABILITIES[1];
const TENANT = PROBE_CAPABILITIES[2];

const RECORDINGS = [
  REC('moto', { [COGNITO]: 'permissive', [COND]: 'verified', [TENANT]: 'verified' }),
  REC('ministack', { [COGNITO]: 'permissive', [COND]: 'verified', [TENANT]: 'verified' }),
];

const RUNTIME_COLUMNS = { moto: 'Moto', ministack: 'MiniStack' } as const;

const CLEAN = [
  `| ${MATRIX_DOC_LABELS[COND]} | ✓ | ✅ | ✅ | x |`,
  `| ${MATRIX_DOC_LABELS[TENANT]} | ✓ | ✅ | ✅ | x |`,
  `| **${MATRIX_DOC_LABELS[COGNITO]}** | ✓ | 🔴 **素通り** | 🔴 **素通り** | x |`,
  `| S3 | | ${POSITIVE_ONLY_MARK} | ${POSITIVE_ONLY_MARK} | x |`,
  `| Bedrock | | ⛔ | ⛔ | x |`,
  `| CDK | | ${UNMEASURED_MARK} | ${POSITIVE_ONLY_MARK} | x |`,
].join('\n');

const reconcile = (rows: string) =>
  reconcileCapabilityDoc({
    tables: table(rows),
    labels: MATRIX_DOC_LABELS,
    recordings: RECORDINGS,
    runtimeColumns: RUNTIME_COLUMNS,
    negativeControlColumn: '負の対照',
  });

const kinds = (rows: string) => reconcile(rows).map((d) => d.kind);

describe('記号の語彙', () => {
  /**
   * 🔴 **下界**: 「食い違いが無い」だけを主張する検査は、記号が全部同じでも空虚に通る。
   * 未測の行が使う記号が `matrixMark` のどれとも衝突しないことを先に縛る。
   */
  it('未測・正のみの記号は verdict の記号と衝突しない', () => {
    const verdictMarks = CAPABILITY_VERDICTS.map(matrixMark);
    expect(verdictMarks).not.toContain(POSITIVE_ONLY_MARK);
    expect(verdictMarks).not.toContain(UNMEASURED_MARK);
    expect(POSITIVE_ONLY_MARK).not.toBe(UNMEASURED_MARK);
  });

  /**
   * 「負の対照が無ければ書けない記号」は**判定関数から導出する**。手で並べない。
   * `classifyCapability` を緩める変異は、この一覧を痩せさせることで露見する。
   */
  it('負の対照なしでは到達できない verdict だけが予約されている', () => {
    expect([...NEGATIVE_CONTROL_ONLY_VERDICTS].sort()).toEqual(['permissive', 'verified']);
  });
});

describe('表のパース', () => {
  it('見出しが一致する表だけを取り、行と行番号を返す', () => {
    const parsed = table(CLEAN);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.headers).toEqual(['Service / 操作', '負の対照', 'Moto', 'MiniStack', 'Notes']);
    expect(parsed[0]!.rows).toHaveLength(6);
    // 行番号は 1 始まりで、ヘッダ 2 行の後から始まる。
    expect(parsed[0]!.rows[0]?.line).toBe(3);
  });

  it('別の表を取り違えない', () => {
    const md = ['| 判定 | 記号 |', '| --- | --- |', '| verified | ✅ |'].join('\n');
    expect(parseMarkdownTables(md, 'Service / 操作')).toEqual([]);
    expect(parseMarkdownTables(md, '判定')[0]!.rows).toHaveLength(1);
  });

  /**
   * 🔴 同じ見出しの表が 2 枚あるとき、**1 枚目で打ち切らない**。打ち切ると本物が
   * 無検査になる（レビュー MAJOR-3 の実測経路）。
   */
  it('同じ見出しの表を全部返す', () => {
    expect(table([CLEAN, '', '| Service / 操作 | 負の対照 | Moto | MiniStack | Notes |', '| --- | --- | --- | --- | --- |', '| X | | ⛔ | ⛔ | x |'].join('\n'))).toHaveLength(2);
  });
});

describe('記録の読み取り', () => {
  it('知らない verdict を受け付けない', () => {
    expect(() => REC('moto', { [COND]: 'ok' })).toThrow(/知らない verdict/);
  });

  it('probe が測らない能力名を受け付けない', () => {
    expect(() => REC('moto', { '知らない能力': 'verified' })).toThrow(/capability/);
  });

  /**
   * 🔴 probe は必ず全能力を 1 件ずつ出す（落ちた測定も `inconclusive` として入る）。
   * 欠けた記録を読めてしまうと、**測っていない行が「一致した」として緑になる**。
   * この guard は変異検証（M13）で**生存**したので後から縛った ―― 守りが
   * 効いているかは、書いた時点では分からない。
   */
  it('能力が欠けた記録を受け付けない', () => {
    expect(() => REC('moto', { [COND]: 'verified', [TENANT]: 'verified' })).toThrow(/欠けている/);
  });

  /**
   * 🔴 **記録は自分自身と整合していなければならない。** `verdict` 文字列 1 個の
   * 書き換えが最も安い改竄で、レビュー MAJOR-1 がそれで緑を実測した。
   */
  it('verdict が測定値から導けない記録を受け付けない', () => {
    expect(() =>
      parseRecording({
        runtime: 'moto',
        measuredAt: 'x',
        results: PROBE_CAPABILITIES.map((c) =>
          c === COND
            ? entry(c, 'verified', { positive: 'failed', negative: 'accepted' })
            : entry(c, 'verified'),
        ),
      }),
    ).toThrow(/整合しない/);
  });

  it('知らない対照の結果を受け付けない', () => {
    expect(() =>
      parseRecording({
        runtime: 'moto',
        measuredAt: 'x',
        results: PROBE_CAPABILITIES.map((c) => entry(c, 'verified', { negative: 'maybe' })),
      }),
    ).toThrow(/対照の結果/);
  });

  /**
   * 🔴 **probe と記録を結ぶ唯一の紐。** 測定関数の対応がずれた probe で取った記録は、
   * 説明が食い違うことでここで落ちる（レビュー MAJOR-2）。
   */
  it('対照の説明が probe と違う記録を受け付けない', () => {
    expect(() =>
      parseRecording({
        runtime: 'moto',
        measuredAt: 'x',
        results: PROBE_CAPABILITIES.map((c) =>
          entry(c, 'verified', c === TENANT ? { positiveDesc: '別の説明' } : {}),
        ),
      }),
    ).toThrow(/説明が probe と一致しない/);
  });

  it('runtime と measuredAt が要る', () => {
    expect(() => parseRecording({ results: [] })).toThrow(/runtime/);
    expect(() => parseRecording({ runtime: 'moto', results: [] })).toThrow(/measuredAt/);
  });
});

describe('突き合わせ', () => {
  it('実物どおりの表なら食い違いは 0 件', () => {
    expect(reconcile(CLEAN)).toEqual([]);
  });

  /** 6 周のうち 1 周目・5 周目がこの型（✅ と書いてあるが実測は素通り / その逆）。 */
  it('probe 済みの行の記号が verdict と違えば落ちる', () => {
    const rows = CLEAN.replace(`| **${MATRIX_DOC_LABELS[COGNITO]}** | ✓ | 🔴 **素通り**`, `| **${MATRIX_DOC_LABELS[COGNITO]}** | ✓ | ✅`);
    const found = reconcile(rows);
    expect(found.map((d) => d.kind)).toEqual(['mark_mismatch']);
    // どの行・どの runtime かが分かること（「どこかが違う」では直せない）。
    expect(found[0]?.message).toContain('Moto');
    expect(found[0]?.message).toContain('permissive');
  });

  /** 2 周目の型: 素通りを ⛔（＝「使えないが嘘はつかない」）と書いた。 */
  it('素通りを ⛔ と書き換えても落ちる', () => {
    expect(kinds(CLEAN.replaceAll('🔴 **素通り**', '⛔'))).toEqual(['mark_mismatch', 'mark_mismatch']);
  });

  /** 5 周目の型: probe が測っていない行に「負の対照つき」を立てた。 */
  it('probe の裏付けが無い行が ✓ を立てたら落ちる', () => {
    expect(kinds(CLEAN.replace('| S3 | |', '| S3 | ✓ |'))).toEqual(['unbacked_negative_control']);
  });

  /** 3 周目の型: 正の対照しか無い行が、負の対照つきの記号を使った。 */
  it('probe の裏付けが無い行が予約記号を使ったら落ちる', () => {
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | ✅'))).toEqual([
      'reserved_mark_outside_probe',
    ]);
    expect(kinds(CLEAN.replace(`| CDK | | ${UNMEASURED_MARK}`, '| CDK | | 🔴 素通り'))).toEqual([
      'reserved_mark_outside_probe',
    ]);
  });

  /**
   * 🔴 **装飾を足して突破する族**（#813 と同型）。完全一致のブラックリストだと
   * `✅ 実測` が素通りする ―― レビュー 2 周目が実測した。装飾の有無**両方**を
   * 回帰行列に残す（片方だけでは今と同じ穴が開く）。
   */
  it.each(['✅ 実測', '✅', '✅ (Moto のみ)', '🔴 素通り（一部）', '🔴 **素通り**'])(
    '裏付けの無い行の %s を弾く',
    (cell) => {
      expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, `| S3 | | ${cell}`))).toEqual([
        'reserved_mark_outside_probe',
      ]);
    },
  );

  it('裏付けの無い行が語彙の外の記号を使ったら落ちる', () => {
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | たぶん動く'))).toEqual([
      'unknown_mark',
    ]);
    // 空欄も「主張なし」として通さない（凡例は（未測）と書けと言っている）。
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | '))).toEqual([
      'unknown_mark',
    ]);
  });

  it('末尾の補足は許す（⛔ 405 のような行が実在する）', () => {
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | ⛔ 405'))).toEqual([]);
  });

  it('⛔ は正の対照だけで書けるので、予約されていない', () => {
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | ⛔'))).toEqual([]);
  });

  /** 行ごと消す / ✓ を外す、という「静かな」書き換えも落とす。 */
  it('probe 済みの行が表から消えたら落ちる', () => {
    const rows = CLEAN.split('\n')
      .filter((l) => !l.includes(MATRIX_DOC_LABELS[TENANT]))
      .join('\n');
    expect(kinds(rows)).toEqual(['missing_row']);
  });

  it('probe 済みの行から ✓ が外れたら落ちる', () => {
    const rows = CLEAN.replace(`| ${MATRIX_DOC_LABELS[COND]} | ✓ |`, `| ${MATRIX_DOC_LABELS[COND]} | |`);
    // ✓ が外れると「裏付けはあるのに未測と書いてある」= 区別が壊れている。
    expect(kinds(rows)).toContain('unmarked_backed_row');
  });

  /**
   * 🔴 **exit code は oracle にならない**（#1113 本文）。Cognito の permissive が
   * 単独で非 0 を固定するので、DynamoDB 行だけが壊れた記録も見逃してはならない。
   */
  it('記録側が変わって文書が追随していなくても落ちる', () => {
    const stale = [
      REC('moto', { [COGNITO]: 'permissive', [COND]: 'permissive', [TENANT]: 'verified' }),
      REC('ministack', { [COGNITO]: 'permissive', [COND]: 'verified', [TENANT]: 'verified' }),
    ];
    const found = reconcileCapabilityDoc({
      tables: table(CLEAN),
      labels: MATRIX_DOC_LABELS,
      recordings: stale,
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.map((d) => d.kind)).toEqual(['mark_mismatch']);
    expect(found[0]?.message).toContain(MATRIX_DOC_LABELS[COND]);
  });

  it('runtime の記録が欠けていたら落ちる（黙って 1 つ減らせない）', () => {
    const found = reconcileCapabilityDoc({
      tables: table(CLEAN),
      labels: MATRIX_DOC_LABELS,
      recordings: [RECORDINGS[0]!],
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.map((d) => d.kind)).toEqual(['missing_runtime_recording']);
  });

  it('記録が空なら、表が何と書いてあっても落ちる', () => {
    const found = reconcileCapabilityDoc({
      tables: table(CLEAN),
      labels: MATRIX_DOC_LABELS,
      recordings: [],
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.length).toBeGreaterThan(0);
  });

  /** `parseRecording` を通さずに組み立てた記録が来ても、黙って飛ばさない。 */
  it('記録に測定が欠けていたら、一致ではなく欠落として報告する', () => {
    const broken = [
      { ...RECORDINGS[0]!, results: RECORDINGS[0]!.results.filter((r) => r.capability !== TENANT) },
      RECORDINGS[1]!,
    ];
    const found = reconcileCapabilityDoc({
      tables: table(CLEAN),
      labels: MATRIX_DOC_LABELS,
      recordings: broken,
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.map((d) => d.kind)).toEqual(['missing_measurement']);
    expect(found[0]?.message).toContain('moto');
  });

  it('同じ見出しの表が 2 枚あれば、どちらも読まずに落ちる', () => {
    const dup = [
      CLEAN,
      '',
      '| Service / 操作 | 負の対照 | Moto | MiniStack | Notes |',
      '| --- | --- | --- | --- | --- |',
      `| ${MATRIX_DOC_LABELS[COND]} | ✓ | ✅ | ✅ | x |`,
    ].join('\n');
    expect(kinds(dup)).toEqual(['duplicate_table']);
  });

  it('runtime 列が消えたら、セルが空ではなく列の欠落として報告する', () => {
    const noColumn = parseMarkdownTables(
      ['| Service / 操作 | 負の対照 | Moto | Notes |', '| --- | --- | --- | --- |', `| ${MATRIX_DOC_LABELS[COND]} | ✓ | ✅ | x |`].join('\n'),
      'Service / 操作',
    );
    const got = reconcileCapabilityDoc({
      tables: noColumn,
      labels: MATRIX_DOC_LABELS,
      recordings: RECORDINGS,
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(got.map((d) => d.kind)).toContain('missing_column');
    expect(got.find((d) => d.kind === 'missing_column')?.message).toContain('MiniStack');
  });

  it('同じ runtime の記録が 2 件あれば、先勝ちで黙らせずに落ちる', () => {
    const got = reconcileCapabilityDoc({
      tables: table(CLEAN),
      labels: MATRIX_DOC_LABELS,
      recordings: [...RECORDINGS, RECORDINGS[0]!],
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(got.map((d) => d.kind)).toEqual(['duplicate_runtime_recording']);
  });

  it('表そのものが見つからなければ落ちる', () => {
    const found = reconcileCapabilityDoc({
      tables: [],
      labels: MATRIX_DOC_LABELS,
      recordings: RECORDINGS,
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.map((d) => d.kind)).toEqual(['table_not_found']);
  });
});

describe('負の対照列を持たない表（証拠表）', () => {
  const evidence = (rows: string) =>
    parseMarkdownTables(['| 能力 | MiniStack | Moto |', '| --- | --- | --- |', rows].join('\n'), '能力');
  const LABELS = { [COGNITO]: 'C', [COND]: 'A', [TENANT]: 'B' } as Record<string, string>;
  const run = (rows: string) =>
    reconcileCapabilityDoc({
      tables: evidence(rows),
      labels: LABELS as never,
      recordings: RECORDINGS,
      runtimeColumns: { ministack: 'MiniStack', moto: 'Moto' },
    }).map((d) => d.kind);

  const OK = ['| A | ✅ verified | ✅ verified |', '| B | ✅ verified | ✅ verified |', '| C | 🔴 素通り | 🔴 素通り |'].join('\n');

  it('記号＋verdict 名の表記も受ける', () => {
    expect(run(OK)).toEqual([]);
  });

  it('全行が probe の裏付けを要求される', () => {
    // 裏付けの無い行が ✅ を使うのは**2 つ**の違反である（裏付けが無い／記号が予約されている）。
    // 片方だけ報告すると、もう片方を直しただけで緑になる。
    expect(run([OK, '| 余計な行 | ✅ verified | ✅ verified |'].join('\n'))).toEqual([
      'unbacked_negative_control',
      'reserved_mark_outside_probe',
      'reserved_mark_outside_probe',
    ]);
  });

  it('裏付けの無い行は、予約されていない記号なら置ける', () => {
    expect(run([OK, `| 余計な行 | ${POSITIVE_ONLY_MARK} | ⛔ |`].join('\n'))).toEqual([
      'unbacked_negative_control',
    ]);
  });

  it('記号と verdict 名が食い違ったら落ちる', () => {
    expect(run(OK.replace('| C | 🔴 素通り |', '| C | ✅ verified |'))).toEqual(['mark_mismatch']);
  });
});
