import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MATRIX_DOC_LABELS,
  PROBE_CAPABILITIES,
  POSITIVE_ONLY_MARK,
  SANDBOX_DOC_LABELS,
  UNMEASURED_MARK,
  RESERVED_MARK_INVENTORY,
  findLegendRowGaps,
  findReservedMarkViolations,
  findScopeGaps,
  SCOPE_KEY_MARK,
  containsMark,
  normalizeForMarkScan,
  parseMarkdownTables,
  parseRecording,
  reconcileCapabilityDoc,
  type CapabilityRecording,
} from '../../src/domain/governance/capability-doc';
import { CAPABILITY_VERDICTS, matrixMark } from '../../src/domain/governance/emulator-capability';

/**
 * 文書の能力表を、**probe の実測記録**と行ごとに突き合わせる（#1113）。
 *
 * ## なぜ要るか
 *
 * `docs/local-aws.md` の matrix と `docs/development/local-aws-sandbox.md` の証拠表は、
 * 同じ実測を**人が 2 箇所へ転記したもの**だった。#1103 / PR #1110 のレビューは 6 周に
 * わたってセルが嘘であることを検出し続け、**うち 3 周は、直前の周が「この型を直すために」
 * 書き換えた表の中で再発した**。セルを直し続けるやり方は実測として機能していない。
 *
 * ## エミュレータを前提にしない
 *
 * 🔴 突き合わせる相手は `docs/evidence/emulator-capability.*.json`（probe の `--json`
 * 出力そのもの）であって、probe の実行ではない。だからこの検査は**既定のゲートの中**で
 * 走る（#1103 条件 5「既定のゲートを変えない」。probe をゲートで走らせるのは #1113 の非目標）。
 *
 * 記録を取り直す手順は `docs/evidence/README.md`。
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const RUNTIME_COLUMNS = { moto: 'Moto', ministack: 'MiniStack' } as const;

const RUNTIMES = ['ministack', 'moto'] as const;

const RECORDINGS: ReadonlyArray<CapabilityRecording> = RUNTIMES.map((runtime) =>
  parseRecording(JSON.parse(read(`docs/evidence/emulator-capability.${runtime}.json`))),
);

describe('実測記録', () => {
  /**
   * 🔴 **下界**。「食い違いが 0 件」は、記録が空でも表が空でも空虚に通る
   * （`CLAUDE.md`「検証の作法」の「下界を併せて縛る」）。**何がどれだけ在るか**を先に固定する。
   */
  it('両 runtime の記録が在り、probe の全能力を覆っている', () => {
    // 🔴 **順序を保ったまま比べる。** `sort()` すると「ファイル名と中身の runtime が
    // 入れ替わっている」（`AWS_RUNTIME=moto … > …ministack.json`）を集合として見逃す。
    expect(RECORDINGS.map((r) => r.runtime)).toEqual([...RUNTIMES]);
    for (const recording of RECORDINGS) {
      expect(recording.results.map((r) => r.capability).sort()).toEqual([...PROBE_CAPABILITIES].sort());
      expect(Number.isNaN(Date.parse(recording.measuredAt))).toBe(false);
    }
  });

  /**
   * 記録が「全部 ✅」へ書き換えられたら、この検査の意味は消える。**素通りが記録に
   * 残っていること**まで縛る ―― Cognito は実測で `permissive` であり、それが
   * 「ローカルで管理者ログインを検証しない」という運用判断の根拠である（#1111）。
   */
  it('Cognito の素通りが記録に残っている', () => {
    for (const recording of RECORDINGS) {
      const cognito = recording.results.find((r) => r.capability === PROBE_CAPABILITIES[0]);
      expect(cognito?.verdict, `${recording.runtime} の Cognito が permissive でない`).toBe(
        'permissive',
      );
    }
  });
});

describe('docs/local-aws.md の compatibility matrix', () => {
  const tables = parseMarkdownTables(read('docs/local-aws.md'), 'Service / 操作');
  const table = tables[0];

  it('表が見つかり、行が痩せていない', () => {
    expect(table).not.toBeNull();
    // 実測 15 行（2026-09-15）。**行が消えても気づけるように**下界を置く。
    expect(table!.rows.length).toBeGreaterThanOrEqual(15);
    expect(table!.headers).toEqual(['Service / 操作', '負の対照', 'Moto', 'MiniStack', 'Real AWS 必須', 'Notes']);
  });

  it('負の対照つきの行は probe が測っている 3 行だけ', () => {
    const backed = table!.rows.filter((row) => (row.cells[1] ?? '').length > 0).map((row) => row.cells[0]);
    expect([...backed].sort()).toEqual(PROBE_CAPABILITIES.map((c) => MATRIX_DOC_LABELS[c]).sort());
  });

  /**
   * AC3: 「まだ測っていない」と「測って ✅ だった」が**表記上**区別される。
   * 記号そのものが担保していることを直接数える（凡例の文章ではなく）。
   */
  it('✅ は負の対照つきの行にしか現れない', () => {
    const verified = matrixMark('verified');
    const runtimeIndexes = Object.values(RUNTIME_COLUMNS).map((h) => table!.headers.indexOf(h));
    const rowsWithVerified = table!.rows.filter((row) =>
      runtimeIndexes.map((i) => row.cells[i]).includes(verified),
    );
    expect(rowsWithVerified.every((row) => (row.cells[1] ?? '').length > 0)).toBe(true);
    // 下界: ✅ が 1 つも無い表でも上の主張は通ってしまう。
    expect(rowsWithVerified.length).toBeGreaterThan(0);
    // 正の対照だけの行が実在し、✅ と別の記号を使っている。
    expect(table!.rows.some((row) => row.cells.includes(POSITIVE_ONLY_MARK))).toBe(true);
  });

  /**
   * 🔴 **凡例の「判定 → 記号」の対応を検査する。** ここが無検査だと、
   * `| verified | ◯ 正のみ |` と書き換えるだけで 12 行の意味が変わる（レビュー MAJOR-4a が
   * それで緑を実測した）。記号の出どころは `matrixMark` 一箇所である。
   * **意味を説明する 3 列目は縛っていない**（散文なので。AC3 は記号が担う設計）。
   */
  it('凡例の記号が matrixMark と一致し、未測・正のみの行が在る', () => {
    const legend = parseMarkdownTables(read('docs/local-aws.md'), '判定');
    expect(legend).toHaveLength(1);
    const marks = new Map(legend[0]!.rows.map((row) => [row.cells[0] ?? '', row.cells[1] ?? '']));
    for (const verdict of CAPABILITY_VERDICTS) {
      expect(marks.get(`\`${verdict}\``), `凡例の ${verdict} が matrixMark と違う`).toBe(
        matrixMark(verdict),
      );
    }
    // 下界: 予約されていない記号の行も凡例に在ること（消えると区別が読めなくなる）。
    expect([...marks.values()]).toContain(POSITIVE_ONLY_MARK);
    expect([...marks.values()]).toContain(UNMEASURED_MARK);
  });

  /**
   * 「測っていない」→「操作は通った」の格上げは、probe が測らない行なので verdict では
   * 縛れない。**語彙が消えていないこと**だけを下界として置く（レビュー MAJOR-4b）。
   */
  it('（未測）を持つ行が増減していない', () => {
    // 🔴 「1 つ以上ある」だと、2 件目が増えた後は 1 件目の格上げが静かに通る（#813 の
    // 「件数 vs 下界」と同型の劣化）。**行の集合**で縛って増減の両方を見えるようにする。
    const unmeasured = table!.rows
      .filter((row) => row.cells.some((cell) => cell.startsWith(UNMEASURED_MARK)))
      .map((row) => row.cells[0]);
    expect(unmeasured).toEqual(['CloudFormation / CDK deploy + diff']);
  });

  it('実測記録と食い違わない', () => {
    const found = reconcileCapabilityDoc({
      tables,
      labels: MATRIX_DOC_LABELS,
      recordings: RECORDINGS,
      runtimeColumns: RUNTIME_COLUMNS,
      negativeControlColumn: '負の対照',
    });
    expect(found.map((d) => `${d.kind} @${d.line ?? '-'}: ${d.message}`)).toEqual([]);
  });
});

describe('docs/development/local-aws-sandbox.md の証拠表', () => {
  const tables = parseMarkdownTables(read('docs/development/local-aws-sandbox.md'), '能力');
  const table = tables[0];

  it('表が見つかり、probe が測る行だけで出来ている', () => {
    expect(tables).toHaveLength(1);
    expect(table!.rows).toHaveLength(PROBE_CAPABILITIES.length);
  });

  /** 🔴 転記先が 2 つある以上、片方だけ縛っても意味が薄い。両方を同じ記録へ縛る。 */
  it('実測記録と食い違わない', () => {
    const found = reconcileCapabilityDoc({
      tables,
      labels: SANDBOX_DOC_LABELS,
      recordings: RECORDINGS,
      runtimeColumns: { ministack: 'MiniStack', moto: 'Moto' },
    });
    expect(found.map((d) => `${d.kind} @${d.line ?? '-'}: ${d.message}`)).toEqual([]);
  });
});

/**
 * 🔴 **予約記号は、許した表の許した列にしか現れてはならない**（#1114）。
 *
 * #1113 の検査は「検査対象 2 表の runtime 列」しか見ておらず、独立レビューが
 * **4 つの逃げ道**を実測した —— matrix の `Notes` 列 / `Real AWS 必須` 列 /
 * 別の表（`| 段 | 結果 |`）/ 別文書の 2 表。いずれも検査は緑のままだった。
 * 列を足して塞ぐのではなく、**許す側を数え上げて**族ごと閉じる。
 */
describe('予約記号の適用範囲（文書全体）', () => {
  const FILES = Object.keys(RESERVED_MARK_INVENTORY);

  it.each(FILES)('%s の予約記号の出現が目録と一致する', (file) => {
    const found = findReservedMarkViolations({
      file,
      markdown: read(file),
      inventory: RESERVED_MARK_INVENTORY[file]!,
    });
    expect(found.map((v) => `${v.kind} L${v.line}: ${v.text}`)).toEqual([]);
  });

  /**
   * 🔴 **ファイル軸も閉包にする。** 予約記号を含む文書が目録に載っていなければ落ちる。
   * 鍵は `🔴 素通り` に限る —— `✅` はこのリポジトリで「済み」の汎用記号で、
   * 13 文書・100 行超が能力と無関係に使っている（理由は `SCOPE_KEY_MARK` の注記）。
   * 走査根は**リポジトリ全体**（`node_modules` と `.git` を除く）。`docs/` と
   * `.claude/rules/` に狭めていたときは `CLAUDE.md` と `.claude/skills/**` が閉包の外だった。
   */
  it('予約記号を持つ文書が、目録の対象から漏れていない', () => {
    // 🔴 **根を数え上げない。** `docs` と `.claude/rules` だけを見ていたため、`CLAUDE.md` と
    // `.claude/skills/**` が閉包の外だった —— どちらも Cognito 素通りの事実が既に転記されて
    // いる場所で、そこへ**逆の主張**を書いても緑だった（レビュー実測）。リポジトリ全体を見る。
    const scanned = execSync(
      `find . -name '*.md' -type f -not -path './node_modules/*' -not -path './.git/*'`,
      { cwd: process.cwd(), encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//u, ''));
    const carriers = scanned
      // 🔴 **正規化してから引く。** 生文字列だと正準表記 `🔴 **素通り**`（太字）に一致せず、
      // 既存 matrix からコピーして作った新文書が閉包を素通りする（レビュー実測）。
      // 全文を正規化するので、改行での分断も同時に拾える。
      .filter((f) => containsMark(normalizeForMarkScan(read(f)), SCOPE_KEY_MARK))
      .sort();
    expect(carriers.length, '予約記号を持つ文書が 1 つも無い（検査が空振り）').toBeGreaterThan(0);
    // 🔴 **走査根が痩せていないことを観測可能にする。** 根を `docs` へ狭める変異は、今日
    // 根の外に carrier が無いというだけで生存する。**走査した集合に repo 直下と
    // `.claude/skills/**` が含まれること**を直接縛れば、狭める変異が落ちる。
    expect(scanned, 'リポジトリ直下の md を走査していない').toContain('CLAUDE.md');
    expect(
      scanned.some((f) => f.startsWith('.claude/skills/')),
      '.claude/skills/** を走査していない',
    ).toBe(true);
    expect(findScopeGaps({ carriers, scope: RESERVED_MARK_INVENTORY })).toEqual([]);
  });

  it('凡例の行が導出値ぴったりで、余計な行が無い', () => {
    const legend = parseMarkdownTables(read('docs/local-aws.md'), '判定')[0]!;
    expect(findLegendRowGaps(legend.rows.map((r) => r.cells[0] ?? ''))).toEqual([]);
  });

  /** 🔴 **下界。** 目録が空でも「一致」は通る。実物に出現が在ることを固定する。 */
  it('目録が痩せていない（検査が空振りしていない）', () => {
    // 空目録は「記号ゼロを固定する」ファイル（ADR）なので、一律に非空は要求できない。
    // 縛るのは「**検査が何も持っていない世界**」でないこと。
    // 🔴 **キー集合を固定する。** 空目録（ゼロ固定）のファイル項目は 1 行消すだけで
    // 無力化でき、他に何も落ちなかった（変異検証で実測）。キーの下界で閉じる。
    expect([...Object.keys(RESERVED_MARK_INVENTORY)].sort()).toEqual([
      'docs/adr/0010-swappable-aws-emulator.md',
      'docs/development/local-aws-sandbox.md',
      'docs/local-aws.md',
    ]);
    // 🔴 **件数はファイルごとに固定する。** 総数の緩い下界（`> 10`）だと、散文の項目を
    // 黙って 6 件まで削れた（レビュー実測）。**削除が数値の差分として必ず見える**ようにする。
    expect(
      Object.fromEntries(Object.entries(RESERVED_MARK_INVENTORY).map(([f, v]) => [f, v.length])),
    ).toEqual({
      'docs/local-aws.md': 14,
      'docs/development/local-aws-sandbox.md': 4,
      // 空＝「この文書に予約記号が 1 つも在ってはならない」の意味。
      'docs/adr/0010-swappable-aws-emulator.md': 0,
    });
    const marks = CAPABILITY_VERDICTS.map(matrixMark);
    const matrix = parseMarkdownTables(read('docs/local-aws.md'), 'Service / 操作')[0]!;
    expect(matrix.rows.flatMap((r) => r.cells).filter((c) => marks.includes(c))).not.toHaveLength(0);
  });
});
