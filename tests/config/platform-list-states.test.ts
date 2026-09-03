import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * platform の一覧が「読めない/0 件/失敗」を描き分け、狭い画面で壊れない (#896 / 課題 06)。
 *
 * ## なぜ構造で縛るか
 *
 * **同じ直し方が既に同じディレクトリに在るのに伝播していなかった。** `AwsCostPanel` は
 * 表を `overflowX: 'auto'` の領域に入れ、エラーを `role="alert"` で出している。残り 8 ファイルは
 * どちらも持っていない。`AdminReadGate`（#870）のときと同型で、**各画面が自前で書き続ける限り、
 * 次に画面を足す人がまた同じ穴を開ける。**
 *
 * ここが見るのは構造の退行:
 *
 *   1. 表が**横スクロールできる領域の中に居る**こと。外に居ると、狭い画面
 *      （iPad 縦・分割表示）で**ページごと横スクロールする**
 *   2. エラー表示が `role="alert"` を持つこと。裸の `<p>` はスクリーンリーダーに何も伝えない
 *   3. 一覧が「読み込み中 / 失敗 / 0 件」を**描き分ける**こと
 *
 * 🔴 **下界を張る（#896 AC4）。** 上のどれも「表を全部消す」「エラー表示を全部消す」で
 * 空虚に満たせる。**表とエラー表示が実際に在ること**を併せて要求する。
 *
 * ## 方式を替えたので、前の方式が守っていた変異を当て直している
 *
 * #896 AC1 で 13 の生 `<table>` を共有 `ui/DataTable` へ寄せた結果、**前の方式
 * （生 `<tbody>` に `TableBodyState` を置く）が守っていた対象がほぼ消えた**。
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」に従い、前の方式が
 * 殺していた変異を新しい形に写している（対応は下の表のとおり）:
 *
 * | 前の方式が殺していた変異 | 新しい形での対応 |
 * | --- | --- |
 * | `TableBodyState` を tbody から外す | `DataTable` から `loaded`/`failed` を外す |
 * | 片方（`loaded` だけ）を渡す | 同上（対で渡すことを要求する） |
 * | 免除に広すぎる式（`.map(`）を足して全部免除にする | 免除はちょうど 1 つの tbody に当たること |
 * | 表を全部消して主張を空虚に満たす | 生 + `DataTable` の合計、および状態を渡す `DataTable` の下界 |
 * | 表を `overflowX` の外へ出す | 同左（生 `<table>` に対して継続） |
 * | エラー表示から `role="alert"` を外す | 同左 |
 * | 生の一覧表を新しく足して素通りさせる | `RAW_TABLE_BUDGET`（生 `<table>` を増やさせない） |
 */

const PLATFORM_DIR = join(process.cwd(), 'src/components/admin/platform');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function platformFiles(): { name: string; source: string }[] {
  return readdirSync(PLATFORM_DIR)
    .filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))
    .map((name) => ({ name, source: stripComments(readFileSync(join(PLATFORM_DIR, name), 'utf8')) }));
}

/** `<table>` を含むファイル。 */
function filesWithTable(): { name: string; source: string }[] {
  return platformFiles().filter((f) => /<table\b/.test(f.source));
}

/**
 * エラー文言を描いている箇所を粗く拾う。
 *
 * `{error ? <p …>{error}</p> : null}` の形（`error` / `loadError` / `saveError` 等）を、
 * **要素のタグまで**取り出す。文字列で `error` を含むだけの行は拾わない。
 */
function errorElements(source: string): string[] {
  return [...source.matchAll(/\{\s*\w*[eE]rror\w*\s*(?:!==\s*null\s*)?\?\s*\(?\s*(<[a-zA-Z][^>]*>)/g)].map(
    (m) => m[1] ?? '',
  );
}

/** `<tbody> ... </tbody>` を粗く切り出す（platform の表は入れ子にしていない）。 */
function tbodyBlocks(source: string): string[] {
  return [...source.matchAll(/<tbody>[\s\S]*?<\/tbody>/g)].map((m) => m[0]);
}

/** `<table ...> ... </table>` を粗く切り出す。 */
function tableBlocks(source: string): string[] {
  return [...source.matchAll(/<table\b[\s\S]*?<\/table>/g)].map((m) => m[0]);
}

/** `<DataTable ... />` を粗く切り出す。 */
function dataTableBlocks(source: string): string[] {
  return [...source.matchAll(/<DataTable\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/**
 * 生 `<table>` の残数の上限 (#896 AC1)。
 *
 * 13 の一覧表を `ui/DataTable` へ寄せたあと、生で残っているのは **`ProviderConfig` の
 * 1 つだけ**で、それは一覧ではなく**フォームの行組み**（ラベルと入力の対）である。
 * ここを上限で縛るのは、「寄せた」を宣言したあとに**生の一覧表がまた生えてくる**のを
 * 止めるため（`AdminReadGate` の轍。各画面が自前で書き始めると同じ穴がまた開く）。
 */
const RAW_TABLE_BUDGET = 1;

/**
 * `TableBodyState` も `DataTable` の状態受け渡しも使わない `<tbody>`。**理由を必ず書く。**
 *
 * 「使っていない」には 2 種類あり、どちらも正当:
 *
 *   1. **別の形で既に区別している** … 表の外で `{data && rows.length === 0 ? … }` を出し、
 *      表そのものを `rows.length > 0` で描いている。中へ移すのは churn で、直しではない
 *   2. **状態が起こらない** … 行が定数から来るので「読み込み中」も「0 件」も存在しない
 *
 * `file` ではなく **`field`（その tbody が map している式）** で持つ。ファイル単位にすると、
 * 表を 4 つ持つファイル（`MaintenanceStatus`）で 1 つ直せば残り 3 つが素通りする。
 */
const EXEMPT_TBODY: readonly { readonly field: string; readonly why: string }[] = [
  {
    field: 'PROVIDER_IDS.map(',
    why: 'ProviderConfig: 一覧ではなくフォームの行組みで、行は定数 `PROVIDER_IDS` から描くので読み込み中も 0 件も起こらない',
  },
];

function isExempt(body: string): boolean {
  return EXEMPT_TBODY.some((e) => body.includes(e.field));
}

describe('platform の一覧の状態表示 (#896 / 課題 06)', () => {
  /*
   * 🔴 **下界。** 表を全部消せば以下の主張は空虚に満たせるので、**在ること**を先に固定する。
   *
   * ただし数えるのは**生 `<table>` だけではない** —— #896 AC1 で共有 `ui/DataTable` へ
   * 寄せると生の数は減る。減ったことを「表が消えた」と誤検出しないよう、
   * **生 + `DataTable` の合計**で数える（横スクロール領域は `DataTable` が自前で持つので、
   * 寄せた表も「ページごと横スクロールしない」という主張は満たしている）。
   */
  it('🔴 下界: 表を描くファイルが実在する（生でも DataTable でも）', () => {
    const rendering = platformFiles().filter(
      (f) => /<table\b/.test(f.source) || /<DataTable\b/.test(f.source),
    );
    expect(rendering.length).toBeGreaterThanOrEqual(9);
  });

  it('生 <table> は横スクロールできる領域の中に置く（ページごと横スクロールさせない）', () => {
    const offenders = filesWithTable()
      .filter((f) => !/overflowX/.test(f.source))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  /*
   * 生の一覧表を増やさせない (#896 AC1)。
   *
   * 上の下界は「表が在ること」しか言わないので、**生の表を新しく足す**変異は素通りする。
   * 寄せ切ったあとに生えてきた生 `<table>` は、`DataTable` が持つ 3 状態も横スクロールも
   * 自前で書き直すことになり、まさに #896 が潰した穴をもう一度開ける。
   */
  it('生 <table> を増やさない（一覧は ui/DataTable へ寄せる）', () => {
    const raw = platformFiles().flatMap((f) => tableBlocks(f.source).map(() => f.name));
    expect(raw.length).toBeLessThanOrEqual(RAW_TABLE_BUDGET);
  });

  it('🔴 下界: エラー表示が実在する（消して通す形にしない）', () => {
    const withError = platformFiles().filter((f) => errorElements(f.source).length > 0);
    expect(withError.length).toBeGreaterThanOrEqual(8);
  });

  it('エラー表示は role="alert" を持つ（スクリーンリーダーへ届く）', () => {
    const offenders = platformFiles().flatMap((f) =>
      errorElements(f.source)
        .filter((tag) => !/role="alert"/.test(tag))
        .map((tag) => `${f.name}: ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * 読み込み中 / 失敗 / 0 件を描き分ける（#896 AC2）。
   *
   * `rows={data?.x ?? []}` だけを渡すと、**`null`（読み込み中）でも空配列（0 件）でも
   * 同じ「0 件です」になる**。失敗しても `data` は `null` のままなので、`read-state.ts` の
   * 言う「失敗が『読み込み中』に化ける」も同時に起きる。`loaded` と `failed` は**対で**
   * 渡す —— 片方だけでは `resolveAdminReadState` が 3 状態を分けられない。
   */
  it('DataTable は loaded と failed を対で渡す（失敗を「読み込み中」に化けさせない）', () => {
    const offenders = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source)
        .filter((block) => !(/\bloaded[=\s/>]/.test(block) && /\bfailed[=\s]/.test(block)))
        .map((block) => `${f.name}: ${/testId="([^"]*)"/.exec(block)?.[1] ?? '(testId なし)'}`),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **下界。** 直上の主張は `DataTable` を全部消せば空虚に満たせる。
   * **状態を渡している一覧が実際に在ること**を併せて要求する（移行した 13 表が下限）。
   */
  it('🔴 下界: loaded / failed を渡す DataTable が実在する', () => {
    const stateful = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source).filter(
        (block) => /\bloaded[=\s/>]/.test(block) && /\bfailed[=\s]/.test(block),
      ),
    );
    expect(stateful.length).toBeGreaterThanOrEqual(13);
  });

  /*
   * 生 `<tbody>` に戻ってきたときの受け皿を残す（回帰の閂）。
   *
   * 現状ここに当たるのは `ProviderConfig` の 1 つ（免除済み）だけだが、**生の表を足す**
   * 変異は上の `RAW_TABLE_BUDGET` で落ちる。両方あって初めて「生でも `DataTable` でも
   * 状態を描き分ける」が閉じる。
   */
  it('行を map で描く <tbody> は TableBodyState を持つ（読み込み中と 0 件を混ぜない）', () => {
    const offenders = platformFiles().flatMap((f) =>
      tbodyBlocks(f.source)
        .filter((body) => /\.map\(/.test(body))
        .filter((body) => !isExempt(body))
        .filter((body) => !/<TableBodyState\b/.test(body))
        .map(() => f.name),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * `colSpan` が列数と食い違うと**行が崩れる**。表の `<th>` の数と `columns` を突き合わせる。
   * 列を足したのに `columns` を直し忘れる、という実際に起きる形をここで止める。
   */
  it('TableBodyState の columns は表の列数と一致する', () => {
    const offenders = platformFiles().flatMap((f) =>
      tableBlocks(f.source)
        .filter((table) => /<TableBodyState\b/.test(table))
        .flatMap((table) => {
          const headers = (table.match(/<th\b/g) ?? []).length;
          const declared = Number(/columns=\{(\d+)\}/.exec(table)?.[1]);
          return headers === declared ? [] : [`${f.name}: <th>=${headers} columns=${declared}`];
        }),
    );
    expect(offenders).toEqual([]);
  });

  it('免除には理由が書かれている', () => {
    const missing = EXEMPT_TBODY.filter((e) => e.why.trim().length < 10);
    expect(missing.map((e) => e.field)).toEqual([]);
  });

  /*
   * 🔴 **免除を水増しさせない。**
   *
   * 「実在する tbody に当たること」だけでは足りない —— 変異検証で分かった:
   * `{ field: '.map(' }` を 1 行足すと**全部の tbody が免除**になり、それでも
   * 「実在する」は満たされるので素通りした（実測。この主張を足す前は生存した）。
   *
   * 免除は**ちょうど 1 つの tbody に当たること**を要求する。広すぎる式（`.map(` 等）は
   * 複数に当たって落ち、実在しない式は 0 に当たって落ちる。
   */
  it('🔴 下界: 免除はちょうど 1 つの <tbody> に当たる（広すぎる式で全部免除にしない）', () => {
    const bodies = platformFiles().flatMap((f) => tbodyBlocks(f.source));
    const offenders = EXEMPT_TBODY.map((e) => ({
      field: e.field,
      hits: bodies.filter((b) => b.includes(e.field)).length,
    }))
      .filter((x) => x.hits !== 1)
      .map((x) => `${x.field} → ${x.hits} 件`);
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **免除の数と、免除された tbody の数が一致する。**
   *
   * 直上の「ちょうど 1 つに当たる」は、**残る tbody が 1 つしか無い今の状態では
   * 効かない** —— `.map(` のような広すぎる式でも、当たる先が 1 つしか無ければ
   * 「ちょうど 1 つ」を満たしてしまう。実際に #896 AC1 で 13 表を `DataTable` へ
   * 寄せたあと、**前の方式なら殺せていた `.map(` 変異が生存した**（実測）。
   * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」の言う、
   * 母集団が縮んだせいで**前の方式が守っていた保証が落ちた**型である。
   *
   * 母集団の大きさに依らない形へ変える: **免除 1 件につき免除される tbody が 1 つ**。
   * 余分な免除を足せば「登録は N 件なのに免除された tbody は N-1 個」になって落ちる。
   */
  it('🔴 下界: 免除の件数と免除された <tbody> の数が一致する（余分な免除を足させない）', () => {
    const bodies = platformFiles().flatMap((f) => tbodyBlocks(f.source));
    const exempted = bodies.filter((b) => isExempt(b));
    expect(exempted.length).toBe(EXEMPT_TBODY.length);
  });
});
