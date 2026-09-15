import { describe, expect, it } from 'vitest';
import {
  MATRIX_DOC_LABELS,
  NEGATIVE_CONTROL_ONLY_VERDICTS,
  POSITIVE_ONLY_MARK,
  PROBE_CAPABILITIES,
  UNMEASURED_MARK,
  CAPABILITY_CONTROLS,
  findLegendRowGaps,
  findReservedMarkViolations,
  findScopeGaps,
  LEGEND_ROWS,
  SCOPE_KEY_MARK,
  normalizeForMarkScan,
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
  /**
   * 🔴 **前の方式が受理した入力集合を固定する。** 区切り行を `-{2,}` へ狭めたことがあり、
   * GFM として正当な `| - | - |` の表が**丸ごと検査の外へ出た**（`duplicate_table` の保証も
   * 同時に落ちた）。広げたつもりで受理集合を狭める型は、**出力を見ているだけでは気づけない**。
   */
  it.each([
    ['ハイフン 1 本', '| - | - |'],
    ['ハイフン 3 本', '| --- | --- |'],
    ['中央揃え', '|:-:|:-:|'],
    ['左右揃え', '| :- | -: |'],
    ['余白あり', '|  ---  |  ---  |'],
  ])('区切り行 %s を受理する', (_name, sep) => {
    const md = ['| 能力 | Moto |', sep, '| x | y |'].join('\n');
    expect(parseMarkdownTables(md, '能力')).toHaveLength(1);
  });

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

  it('能力が重複した記録を受け付けない', () => {
    expect(() =>
      parseRecording({
        runtime: 'moto',
        measuredAt: 'x',
        results: [...PROBE_CAPABILITIES, COND].map((c) => entry(c, 'verified')),
      }),
    ).toThrow(/重複している/);
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

  /**
   * 🔴 **照合の「向き」を縛る。** `startsWith` を `includes` へ緩める refactor は自然に
   * 見えるが、そうすると `?`（`inconclusive` の記号は 1 文字）を含む任意のセルが通る。
   * レビュー 3 周目が「現状のコードは正しいが向きが縛られていない」として実測した。
   */
  it('記号が先頭に無いセルは語彙として認めない', () => {
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | Moto では ⛔'))).toEqual([
      'unknown_mark',
    ]);
    expect(kinds(CLEAN.replace(`| S3 | | ${POSITIVE_ONLY_MARK}`, '| S3 | | 本当に動く?'))).toEqual([
      'unknown_mark',
    ]);
  });

  /**
   * 🔴 **裏付けのある行は厳密一致である。** 未裏付け行の装飾だけを縛っていると、
   * 裏付け行側を前方一致へ緩める変異が素通りし、`✅ 実測（Moto は未確認）` が書ける。
   */
  it('裏付けのある行に装飾を足したら落ちる', () => {
    const rows = CLEAN.replace(`| ${MATRIX_DOC_LABELS[COND]} | ✓ | ✅ |`, `| ${MATRIX_DOC_LABELS[COND]} | ✓ | ✅ 実測 |`);
    expect(kinds(rows)).toEqual(['mark_mismatch']);
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

describe('予約記号の出現は目録と完全一致する', () => {
  /**
   * 🔴 **表構造で判定しない。** 自前の GFM パーサを判定経路へ置いたところ、レビューが 2 周で
   * 5 つの穴を実測した（先頭パイプ省略 / 引用 / 複数行 HTML / フェンスのスコープ /
   * **区切り行のハイフン 1 本**）。最後のものは受理集合を狭める**退行**でもあった。
   * 綴りを足す競争をやめ、**出現を数え上げる**側へ裏返してある。
   */
  const INV = ['| x | ✅ |'];
  const run = (md: string, inventory: readonly string[] = INV) =>
    findReservedMarkViolations({ file: 'f.md', markdown: md, inventory });

  it('目録どおりなら通る', () => {
    expect(run('| x | ✅ |')).toEqual([]);
  });

  it('目録に無い出現は落ちる（行番号つき）', () => {
    const found = run('| x | ✅ |\n| y | ✅ |');
    expect(found.map((v) => [v.kind, v.line])).toEqual([['unblessed', 2]]);
  });

  /** 🔴 片側だけ主張しない。**全部消せば通る**世界を作らない。 */
  it('目録に在るのに消えた行も落ちる', () => {
    expect(run('（記号なし）').map((v) => v.kind)).toEqual(['missing']);
  });

  /**
   * 構造に依らないことの確認 —— どの綴りで書いても「出現」として同じに扱われる。
   * 1 周目・2 周目で穴だった形を全部入れてある。
   */
  it.each([
    ['先頭パイプ省略', 'x | ✅ 実測'],
    ['引用ブロック', '> | x | ✅ 実測 |'],
    ['HTML（複数行）', '<td>\n✅ 実測\n</td>'],
    ['コードフェンス内', '```\n| x | ✅ 実測 |\n```'],
    ['単一ハイフン区切りの表', '| x | y |\n| - | - |\n| a | ✅ 実測 |'],
    ['4 スペース字下げ', '    | x | ✅ 実測 |'],
    ['見出しセル', '| 段 | 結果（すべて ✅） |'],
    ['散文', 'この能力は ✅ である。'],
  ])('%s でも出現として捕まる', (_name, md) => {
    expect(run(md, []).filter((v) => v.kind === 'unblessed')).not.toHaveLength(0);
  });

  /** 綴りを変える族（#813 と同型）: 装飾・実体参照・タグ・NBSP。 */
  it.each(['🔴 *素通り*', '&#9989; 実測', '<b>✅</b>', '&#128308;&nbsp;素通り', '✅\u00a0実測'])(
    '装飾された %s も出現として捕まる',
    (cell) => {
      expect(run(`| x | ${cell} |`, []).filter((v) => v.kind === 'unblessed')).not.toHaveLength(0);
    },
  );

  /**
   * 🔴 **2 トークンの記号を分断する形**を必ず入れる。`✅` は 1 文字なので、タグや NBSP を
   * 潰さなくても検出できてしまい、**正規化の必要性を測れない**（変異検証で実測: `<b>✅</b>`
   * と `✅\u00a0実測` では正規化を外しても生存した）。`🔴 素通り` で縛る。
   */
  it.each([
    ['タグで分断', '| x | 🔴 <b>素通り</b> |'],
    ['span で分断', '| x | 🔴 <span>素通り</span> |'],
    ['NBSP で分断', '| x | 🔴\u00a0素通り |'],
    ['実体参照 + NBSP', '| x | &#128308;&nbsp;素通り |'],
    ['強調(*)で分断', '| x | 🔴 *素通り* |'],
    // 🔴 `*` だけ入れて `_` を入れ忘れていた（`CLAUDE.md`「同型の 2 本には対策を入れており、
    // 3 本目にだけ入れ忘れていた」と同じ形）。変異検証で生存して分かった。
    ['強調(_)で分断', '| x | 🔴 _素通り_ |'],
    ['強調(_)の ✅', '| x | _✅_ 実測 |'],
  ])('%s でも素通り記号として捕まる', (_name, md) => {
    expect(run(md, []).filter((v) => v.kind === 'unblessed')).not.toHaveLength(0);
  });

  /**
   * 🔴 **「黙って増えない」を主張するなら回数を見なければならない。** 集合所属で判定して
   * いたときは、**祝福済みの行をそっくり別の節へ複製しても無検出**だった（レビュー実測）。
   * しかも構造 allowlist 方式はこれを kill していた＝**方式交換で kill を落としていた**。
   */
  it('祝福済みの行を複製したら落ちる', () => {
    expect(run('| x | ✅ |\n（別の節）\n| x | ✅ |').map((v) => [v.kind, v.line])).toEqual([
      ['unblessed', 3],
    ]);
  });

  it('目録が同じ行を 2 回持つなら 2 回まで許す', () => {
    expect(run('| x | ✅ |\n| x | ✅ |', ['| x | ✅ |', '| x | ✅ |'])).toEqual([]);
    expect(run('| x | ✅ |', ['| x | ✅ |', '| x | ✅ |']).map((v) => v.kind)).toEqual(['missing']);
  });

  /**
   * 🔴 **実体参照で書いたタグは可視テキストである。** 先に復号してからタグ除去すると、
   * `&#60;span …&#62;` が消えて祝福済み行に化ける（レビュー実測）。除去が先、復号が後。
   */
  it('実体参照で作った擬似タグは消さない', () => {
    // 行を改変したので、**両側**が出るのが正しい —— 知らない行が現れ（unblessed）、
    // 祝福済みの行が消えた（missing）。片側だけを期待するのは主張として弱い。
    expect(run('| x | ✅ | &#60;span 実 AWS でも verified&#62;').map((v) => v.kind).sort()).toEqual([
      'missing',
      'unblessed',
    ]);
  });

  it('予約されていない記号は出現として数えない', () => {
    expect(run('| x | ⛔ 405 |\n| y | ◯ 正のみ |\n| z | OK |', [])).toEqual([]);
  });
});

describe('範囲そのものの検査', () => {
  /**
   * 🔴 **鍵は正規化してから引く。** 生文字列で引くと、このリポジトリの正準表記
   * `🔴 **素通り**`（太字）に一度も一致せず、既存 matrix からコピーして作った新文書が
   * 閉包を素通りする（レビュー実測）。改行での分断も全文正規化なら拾える。
   */
  it.each([
    ['太字（正準表記）', '| x | 🔴 **素通り** |'],
    ['改行で分断', 'これは 🔴\n素通り である'],
    ['強調', '🔴 _素通り_'],
  ])('%s でも閉包の鍵として拾える', (_name, text) => {
    expect(normalizeForMarkScan(text)).toContain(SCOPE_KEY_MARK);
  });

  it('予約記号を持つ文書と目録の対象が一致していなければ落ちる', () => {
    const S = (o: Record<string, string[]>) => o;
    expect(findScopeGaps({ carriers: ['a.md'], scope: S({ 'a.md': ['x'] }) })).toEqual([]);
    expect(
      findScopeGaps({ carriers: ['a.md', 'b.md'], scope: S({ 'a.md': ['x'] }) }).map((g) => g.kind),
    ).toEqual(['file_not_in_scope']);
    expect(
      findScopeGaps({ carriers: ['a.md'], scope: S({ 'a.md': ['x'], 'b.md': ['y'] }) }).map((g) => g.kind),
    ).toEqual(['scope_file_without_mark']);
    // 🔴 **空目録は「記号ゼロを固定する」意味**なので、carrier でなくても正しい。
    expect(findScopeGaps({ carriers: ['a.md'], scope: S({ 'a.md': ['x'], 'z.md': [] }) })).toEqual([]);
  });

  it('凡例の行が導出値とずれたら落ちる（多くても少なくても）', () => {
    expect(findLegendRowGaps([...LEGEND_ROWS])).toEqual([]);
    expect(findLegendRowGaps([...LEGEND_ROWS, '捏造']).map((g) => g.kind)).toEqual(['legend_rows_changed']);
    expect(findLegendRowGaps(LEGEND_ROWS.slice(1)).map((g) => g.kind)).toEqual(['legend_rows_changed']);
    // 🔴 **同数の置換**を必ず入れる。3 ケースとも長さを変えていたため、「件数だけ見る」形へ
    // 退化させる変異が生存した（#813 の「件数 vs 下界」と同型）。
    expect(
      findLegendRowGaps(LEGEND_ROWS.map((l, i) => (i === 0 ? 'Cognito SRP' : l))).map((g) => g.kind),
    ).toEqual(['legend_rows_changed']);
  });
});

describe('負の対照列を持たない表（証拠表）', () => {
  const evidence = (rows: string) =>
    parseMarkdownTables(['| 能力 | MiniStack | Moto |', '| --- | --- | --- |', rows].join('\n'), '能力');
  const LABELS = { [COGNITO]: 'C', [COND]: 'A', [TENANT]: 'B' } as Record<string, string>;
  const run = (rows: string) =>
    reconcileCapabilityDoc({
      tables: evidence(rows),
      labels: LABELS as Readonly<Record<ProbeCapability, string>>,
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

/**
 * 範囲の構造的な検査。**テストの assertion ではなく純関数で持つ**ことが要点で、
 * 変異検証で「その 3 つはテスト側にあるあいだ必ず生存する」ことを実測したので持ち上げた。
 */
