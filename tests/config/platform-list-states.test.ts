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
 *   1. 生 `<table>` が**横スクロールできる領域の中に居る**こと。外に居ると、狭い画面
 *      （iPad 縦・分割表示）で**ページごと横スクロールする**
 *   2. エラー表示が `role="alert"` を持つこと。裸の `<p>` はスクリーンリーダーに何も伝えない
 *
 * 🔴 **下界を張る（#896 AC4）。** 上の 2 つは「表を全部消す」「エラー表示を全部消す」で
 * 空虚に満たせる。**表とエラー表示が実際に在ること**を併せて要求する。
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

/**
 * `TableBodyState` を使わない `<tbody>`。**理由を必ず書く。**
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
    field: 'logs.map(',
    why: 'AuditLogs: 表の外で `{data && logs.length === 0 ? …}` を出し、0 件を区別している',
  },
  {
    field: 'rows.map(',
    why: 'UpdateStatus: 表の外で `{data && rows.length === 0 ? …}` を出し、表自体を `rows.length > 0` で描いている',
  },
  {
    field: 'data.breakdown.map(',
    why: 'AwsCostPanel: `data` が載ってからしか表を描かず、`data.breakdown.length === 0` で 0 件を出し分けている',
  },
  {
    field: 'data?.incidents.incidents ?? []',
    why: 'MaintenanceStatus: 表の外で `{data && data.incidents.incidents.length === 0 ? …}` を出している',
  },
  {
    field: 'data?.windows.windows ?? []',
    why: 'MaintenanceStatus: 表の外で `{data && data.windows.windows.length === 0 ? …}` を出している',
  },
  {
    field: 'data?.notices.notices ?? []',
    why: 'MaintenanceStatus: 表の外で `{data && data.notices.notices.length === 0 ? …}` を出している',
  },
  {
    field: 'PROVIDER_IDS.map(',
    why: 'ProviderConfig: 行は定数 `PROVIDER_IDS` から描くので、読み込み中も 0 件も起こらない',
  },
];

function isExempt(body: string): boolean {
  return EXEMPT_TBODY.some((e) => body.includes(e.field));
}

describe('platform の一覧の状態表示 (#896 / 課題 06)', () => {
  it('🔴 下界: 生 <table> を持つファイルが実在する（消して通す形にしない）', () => {
    // 表を全部消せば上の主張は空虚に満たせる。**在ることを先に固定する。**
    expect(filesWithTable().length).toBeGreaterThanOrEqual(9);
  });

  it('生 <table> は横スクロールできる領域の中に置く（ページごと横スクロールさせない）', () => {
    const offenders = filesWithTable()
      .filter((f) => !/overflowX/.test(f.source))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
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
   * `(data?.x ?? []).map(...)` だけで `<tbody>` を描くと、**`null`（読み込み中）でも
   * 空配列（0 件）でも `<tbody>` が空になるだけ**になる。失敗しても `data` は `null` の
   * ままなので、`read-state.ts` の言う「失敗が『読み込み中』に化ける」も同時に起きる。
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

  it('🔴 下界: map で描く <tbody> が実在する（消して通す形にしない）', () => {
    const bodies = platformFiles().flatMap((f) => tbodyBlocks(f.source).filter((b) => /\.map\(/.test(b)));
    expect(bodies.length).toBeGreaterThanOrEqual(6);
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
   * 🔴 **免除を水増しさせない。** 実在しない式を並べて「全部免除」にできると、
   * 上の主張は空虚に満たせる。**免除は全部、実在する tbody に当たること**を要求する。
   */
  it('🔴 下界: 免除はすべて実在する <tbody> に当たる', () => {
    const bodies = platformFiles().flatMap((f) => tbodyBlocks(f.source));
    const dangling = EXEMPT_TBODY.filter((e) => !bodies.some((b) => b.includes(e.field))).map((e) => e.field);
    expect(dangling).toEqual([]);
  });
});
