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
 * | 免除に広すぎる式（`.map(`）を足して全部免除にする | 免除の件数 ⟺ 免除された tbody の数 |
 * | 表を全部消して主張を空虚に満たす | 生 + `DataTable` の合計、および状態を渡す `DataTable` の下界 |
 * | 表を `overflowX` の外へ出す | 生 `<table>` は同左。**寄せた 13 表は `DataTable.test.tsx` が持つ**（下記） |
 * | エラー表示から `role="alert"` を外す | 同左 |
 * | 生の一覧表を新しく足して素通りさせる | `FILES_ALLOWED_RAW_TABLE`（同一性で縛る） |
 * | `colSpan` が列数と食い違う | **構造的に閉じた**ので主張ごと削除（下記） |
 *
 * ## 独立レビューが足した行（自分では出てこなかった族）
 *
 * 上の写しは「自分が思いついた変異」でしかない、と規約は言う。実際、独立レビューが
 * 実測で 3 つの生存を出した。**行列が全部 kill でも「穴が無い」とは言えない**の実例:
 *
 * | 生存した変異 | 塞いだ主張 |
 * | --- | --- |
 * | 配線を定数にする（`loaded={data !== null}` → `loaded`） | 「定数ではなく式へ束ねる」＋ `list-read-state.test.tsx` の実描画 |
 * | サブディレクトリへ画面を足す | `platformFiles()` を再帰にする |
 * | 既存の免除を**拡幅**する（`PROVIDER_IDS.map(` → `.map(`） | 免除は実在する束縛を名指しすること |
 *
 * 2 周目でさらに 10 件の生存が出た。**1 周目で塞いだつもりの族から漏れていた**ものが多い:
 *
 * | 生存した変異 | 塞いだ主張 |
 * | --- | --- |
 * | `overflowX` / `role="region"` / `tabIndex` を `DataTable` から外す | `ui/DataTable.test.tsx`（13 表ぶんの契約が集約された先） |
 * | `scrollRegionLabel` を `DataTable` 側で無視する | 同上（配線を全部残したまま landmark 名が既定へ戻る） |
 * | loading の `role="status"` / `aria-live` を外す | 同上 |
 * | `catch` の中身を無音化する | 「`await fetch` を持つなら `catch` を持つ」（下記 `REQUIRE_FETCH_CATCH`） |
 * | `CONSTANT_READ_STATE` に偽の理由で新規一覧を登録して逃げる | `why` 長・`testId` 実在・`LISTS` の網羅性 |
 * | `scrollRegionLabel` を片方だけ外す（同名衝突しないので通る） | 全 `DataTable` に必須＋platform 全体で一意 |
 */

const PLATFORM_DIR = join(process.cwd(), 'src/components/admin/platform');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * platform 配下の `.tsx` を**再帰的に**集める。
 *
 * 🔴 **非再帰（`readdirSync` 1 段）にしない (#896 レビュー M2)。** ディレクトリ名は
 * `.tsx` で終わらないので `filter` に落ち、**サブディレクトリへ置いた画面が黙って
 * 検査対象から外れる**。レビューで `platform/queues/QueueList.tsx` を足す変異を実測した
 * ところ、`loaded`/`failed` を渡していないのに**どの主張も落ちなかった**。
 */
function platformFiles(): { name: string; source: string }[] {
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, name);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
        out.push({ name, source: stripComments(readFileSync(path, 'utf8')) });
    }
  };
  walk(PLATFORM_DIR, '');
  return out;
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
 * `<DataTable ... />` を粗く切り出す。
 *
 * 終端を最初の `/>` で取るので、**属性値の中に自己閉じ JSX がある**と早く切れる
 * （`emptyMessage={<span>…<br />…</span>}` 等）。切れたブロックが黙って通らないよう、
 * 呼び出し側は「ブロックが `testId=` を含むこと」を併せて要求する (#896 レビュー m5)。
 */
function dataTableBlocks(source: string): string[] {
  return [...source.matchAll(/<DataTable\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

/**
 * 生 `<table>` を残してよいファイル (#896 AC1)。
 *
 * 13 の一覧表を `ui/DataTable` へ寄せたあと、生で残っているのは **`ProviderConfig` の
 * 1 つだけ**で、それは一覧ではなく**フォームの行組み**（ラベルと入力の対）である。
 * 「寄せた」を宣言したあとに**生の一覧表がまた生えてくる**のを止める
 * （`AdminReadGate` の轍。各画面が自前で書き始めると同じ穴がまた開く）。
 *
 * 🔴 **件数ではなく同一性で縛る (#896 レビュー m4)。** `const RAW_TABLE_BUDGET = 1` を
 * `20` にする 1 行変異は、他のどの主張にも触れずに生の表を何枚でも通してしまう。
 * ファイル名の集合で縛れば**上界と下界を同時に**張れる（増やしても、`ProviderConfig` の
 * 表を消して別の場所へ足しても落ちる）。
 */
const FILES_ALLOWED_RAW_TABLE: readonly string[] = ['ProviderConfig.tsx'];

/** `failed` を**式**で渡している（＝失敗が起こりうると主張している）ファイル。 */
function filesWiringFailed(): { name: string; source: string }[] {
  return platformFiles().filter((f) =>
    dataTableBlocks(f.source).some((b) => /\bfailed=\{(?!true\}|false\})/.test(b)),
  );
}

/**
 * `loaded` / `failed` を**定数**に束ねてよい一覧。**理由を必ず書く。**
 *
 * 「状態が起こらない」ことが呼び出し位置から言える場合に限る。式であることを一律に
 * 要求すると、こういう箇所で嘘の式（`loaded={true === true}`）を書かせることになる。
 */
const CONSTANT_READ_STATE: readonly { readonly testId: string; readonly why: string }[] = [
  {
    testId: 'aws-cost-breakdown',
    why: 'AwsCostPanel: `data` が載っている枝の中でしか描かないので loaded は常真・failed は常偽',
  },
];

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
const EXEMPT_TBODY: readonly {
  readonly file: string;
  readonly field: string;
  readonly why: string;
}[] = [
  {
    file: 'ProviderConfig.tsx',
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
  it('生 <table> を持つファイルは許可した 1 つだけ（一覧は ui/DataTable へ寄せる）', () => {
    const raw = platformFiles()
      .filter((f) => tableBlocks(f.source).length > 0)
      .map((f) => f.name)
      .sort();
    expect(raw).toEqual([...FILES_ALLOWED_RAW_TABLE].sort());
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
   * 🔴 **切り出しに失敗したブロックを黙って通さない (#896 レビュー m5)。**
   *
   * `dataTableBlocks` は最初の `/>` で切るので、属性値に自己閉じ JSX が入ると
   * 早く切れる。切れたブロックは `loaded`/`failed` を含まないので直上の主張で落ちるが、
   * 落ちたときの offender 名が `(testId なし)` になって**原因が読めない**。
   * 「全ブロックが `testId=` を持つ」を別に要求して、切り出しの失敗を名指しさせる。
   */
  it('切り出した DataTable ブロックは testId を含む（正規表現の早期終端を検出する）', () => {
    const offenders = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source)
        .filter((block) => !/testId=/.test(block))
        .map((block) => `${f.name}: ${block.slice(0, 60)}…`),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **`loaded` / `failed` を定数に束ねない (#896 レビュー M1)。**
   *
   * 「対で渡している」は**文字列の検査**なので、`loaded={data !== null}` → `loaded`
   * （＝定数 `true`）、`failed={error !== null}` → `failed={false}` という**配線の変異**で
   * 満たせてしまう（独立レビューが実測）。値が状態に由来する式であることを要求する。
   *
   * `loaded` 側は `list-read-state.test.tsx` が実際に描いて観測もしているが、`failed` 側は
   * `useEffect` が走らない静的描画では区別できないため、**ここが唯一の閂**である。
   */
  it('loaded / failed は定数ではなく状態に由来する式へ束ねる', () => {
    const offenders = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source).flatMap((block) => {
        const testId = /testId="([^"]*)"/.exec(block)?.[1] ?? '(testId なし)';
        if (CONSTANT_READ_STATE.some((e) => e.testId === testId)) return [];
        const bad: string[] = [];
        // 属性が無い（`loaded` 単体 = true）か、`{true}` / `{false}` に束ねているもの。
        if (!/\bloaded=\{(?!true\}|false\})/.test(block)) bad.push(`${f.name}: ${testId} の loaded`);
        if (!/\bfailed=\{(?!true\}|false\})/.test(block)) bad.push(`${f.name}: ${testId} の failed`);
        return bad;
      }),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **同じページに同じ名前の landmark を並べない (#896 レビュー M4)。**
   *
   * `DataTable` のスクロール領域は `role="region"` を持つので、`aria-label` が既定の
   * ままだと表を 4 つ持つ `MaintenanceStatus` で**同名の landmark が 4 つ**並び、
   * スクリーンリーダーの landmark 一覧からどれがどの表か判別できなくなる
   * （axe の `landmark-unique`）。同一ファイル内で `DataTable` が複数あるなら、
   * それぞれに固有の `scrollRegionLabel` を要求する。
   */
  it('同一ファイルに複数の DataTable があるなら scrollRegionLabel は固有である', () => {
    const offenders = platformFiles().flatMap((f) => {
      const blocks = dataTableBlocks(f.source);
      if (blocks.length < 2) return [];
      const labels = blocks.map((b) => /scrollRegionLabel="([^"]*)"/.exec(b)?.[1] ?? '(既定)');
      const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
      return [...new Set(dupes)].map((l) => `${f.name}: "${l}" が重複`);
    });
    expect(offenders).toEqual([]);
  });


  /*
   * 🔴 **`failed` を配線したなら、失敗する道が実在すること (#896 レビュー MAJOR-1)。**
   *
   * `failed={error !== null}` と書いても、`error` が**決して真にならない**なら
   * `DataTable` は永遠に「読み込み中」を出す。実際 1 周目のレビューで、8 画面のうち
   * 6 つが `fetch` の reject を拾っておらず、オフライン・DNS 断・HTML 応答で
   * `res.json()` が投げると **失敗が永遠の待ちに化ける**ことが分かった。
   *
   * その主修正（`try/catch` の追加）に**オラクルが 1 本も無かった** —— 2 周目の
   * レビューが catch の中身を `void 0;` に置換したところ**生存**した。CLAUDE.md
   * 「主修正とフォールバックを同じコミットで入れない／主修正を先に縛る」の型である。
   *
   * `failed` を式で渡しているファイルは、**失敗を報告する `catch`** を持つこと。
   * `} catch {` が在るだけでは足りない（中身を消す変異が通る）ので、`setError` を
   * 呼んでいることまで要求する。
   */
  it('failed を式で渡すファイルは、失敗を報告する catch を持つ', () => {
    const offenders = filesWiringFailed()
      .filter((f) => !/catch[\s\S]{0,240}?setError\(/.test(f.source))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **下界。** 直上は「`failed` を式で渡すファイル」が 0 件なら空虚に満たせる。
   * 実在することを併せて固定する（移行した 7 ファイルが下限）。
   */
  it('🔴 下界: failed を式で渡すファイルが実在する', () => {
    expect(filesWiringFailed().length).toBeGreaterThanOrEqual(7);
  });

  /*
   * 🔴 **`scrollRegionLabel` は全部に必須で、platform 全体で一意 (#896 レビュー m2)。**
   *
   * 「同一ファイルに 2 つ以上あるとき」しか見ないと、**1 表だけのファイルを 2 つ
   * 同じページに置く**組み合わせが漏れる（実測: `Integrations` の片方から外す変異が
   * 生存した —— 残り 1 つと名前が衝突しないため）。ページ構成はファイルを跨ぐので、
   * ファイル単位の重複検査では原理的に届かない。全体で一意にしておけば、どのページに
   * どう並べても landmark 名が衝突しない。
   */
  it('全 DataTable が固有の scrollRegionLabel を持つ（platform 全体で一意）', () => {
    const labels = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source).map((b) => {
        const label = /scrollRegionLabel="([^"]*)"/.exec(b)?.[1];
        const testId = /testId="([^"]*)"/.exec(b)?.[1] ?? '(testId なし)';
        return { file: f.name, testId, label };
      }),
    );
    const missing = labels.filter((l) => !l.label).map((l) => `${l.file}: ${l.testId} に scrollRegionLabel が無い`);
    const seen = labels.map((l) => l.label);
    const dupes = [...new Set(seen.filter((l, i) => l && seen.indexOf(l) !== i))].map(
      (l) => `"${l}" が複数の表で使われている`,
    );
    expect([...missing, ...dupes]).toEqual([]);
  });

  /*
   * 🔴 **定数免除にも `EXEMPT_TBODY` と同じ衛生検査を掛ける (#896 レビュー m1)。**
   *
   * 免除簿は 2 枚あるのに検査が片方だけ、という非対称は抜け道になる ——
   * 実測で「新規一覧を `loaded failed={false}` で描き、偽の理由で
   * `CONSTANT_READ_STATE` に 1 行足す」変異が生存した。`why` を空にする変異も通っていた。
   */
  it('定数免除には理由が書かれている', () => {
    const missing = CONSTANT_READ_STATE.filter((e) => e.why.trim().length < 10);
    expect(missing.map((e) => e.testId)).toEqual([]);
  });

  it('🔴 下界: 定数免除は実在する DataTable を名指しする（腐った登録を残さない）', () => {
    const testIds = platformFiles().flatMap((f) =>
      dataTableBlocks(f.source).map((b) => /testId="([^"]*)"/.exec(b)?.[1] ?? ''),
    );
    const offenders = CONSTANT_READ_STATE.filter((e) => !testIds.includes(e.testId)).map((e) => e.testId);
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **`DataTable` を `<table>` の中へ置かない (#896 レビュー m7)。**
   *
   * `DataTable` は `<div>` を返すので `<tbody>` の中に置くと DOM が壊れる（ブラウザが
   * 表の外へ巻き上げ、React は `validateDOMNesting` で警告するだけ）。旧 `TableBodyState`
   * は逆に `<tr>` を返して**必ず表の中**に置く必要があり、props 名も重なるので取り違えやすい。
   */
  it('DataTable は <table> の中に置かない（DOM が壊れる）', () => {
    const offenders = platformFiles().flatMap((f) =>
      tableBlocks(f.source)
        .filter((table) => /<DataTable\b/.test(table))
        .map(() => f.name),
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
   * `colSpan` と列数の食い違いを見ていた主張は**消した** (#896 レビュー m1)。
   *
   * `<TableBodyState>` を含む `<table>` はもう 0 件なので、残しても `offenders` は必ず
   * `[]` になる**空虚な主張**だった。「まだ検査されている」と読めてしまうほうが害が大きい。
   *
   * この族は**構造的に閉じている**: `DataTable` は `columns` から `<th>` と `<td>` の
   * 両方を作るので、列数と `colSpan` が食い違う状態を作れない（状態表示は表の外の
   * `<div>` で、`colSpan` を使わない）。生 `<tbody>` が戻ってきたら復活させること。
   */
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

  /*
   * 🔴 **唯一の免除を「拡幅」する変異を塞ぐ (#896 レビュー m3)。**
   *
   * 直上の 2 つは**免除を足す**変異を殺すが、**既存の免除を広げる**変異は殺せない ——
   * `field: 'PROVIDER_IDS.map('` を `field: '.map('` へ書き換えると、当たる先が 1 つしか
   * 無い今の母集団では `hits === 1` も件数一致も満たして**生存する**。著者が実測で見つけた
   * 「水増し」と同じ根（母集団が 1）から出るもう 1 本である。
   *
   * 免除が**名指ししたファイルの tbody にだけ**当たることを要求する。`.map(` のような
   * 汎用の式は、他のファイルに tbody が増えた瞬間にそちらへも当たって落ちる。
   */
  it('🔴 下界: 免除は名指ししたファイルの <tbody> にだけ当たる（既存の免除を広げさせない）', () => {
    const offenders = EXEMPT_TBODY.flatMap((e) =>
      platformFiles()
        .filter((f) => f.name !== e.file)
        .filter((f) => tbodyBlocks(f.source).some((b) => b.includes(e.field)))
        .map((f) => `${e.field} が ${f.name} にも当たっている`),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * 🔴 **免除は「何を map しているか」を名指しする（拡幅そのものを禁ずる）。**
   *
   * 直上の「他のファイルに当たらない」だけでは足りない —— platform に残る `<tbody>` は
   * 1 つだけなので、`PROVIDER_IDS.map(` を `.map(` へ**書き換える**変異は当たる先が
   * 増えず、件数一致も「ちょうど 1 つ」も他ファイル検査も**全部すり抜ける**（実測で生存）。
   * 母集団が 1 である限り、「当たった数」を数える主張は何を足しても拡幅を殺せない。
   *
   * 数えるのをやめて**式の形**を縛る: 免除は `<識別子>.map(` の形でなければならず、
   * その識別子はそのファイルに**実在する束縛**（import か宣言）でなければならない。
   * `.map(` は識別子を持たないので落ち、`FOO.map(` は宣言が無いので落ちる。
   */
  it('🔴 免除は実在する束縛を名指しする（.map( のような汎用の式を書かせない）', () => {
    const offenders = EXEMPT_TBODY.flatMap((e) => {
      const identifier = /^([A-Za-z_$][\w$]*)\./.exec(e.field)?.[1];
      if (!identifier) return [`${e.field}: 先頭が識別子ではない（何を map しているか分からない）`];
      const file = platformFiles().find((f) => f.name === e.file);
      if (!file) return [`${e.file}: ファイルが無い`];
      // 束縛の実在: import 文か、`const`/`let`/`function` の宣言に現れること。
      const declared = new RegExp(
        `(^|\\n)\\s*(import[^;]*\\b${identifier}\\b|(const|let|var|function)\\s+${identifier}\\b)`,
      ).test(file.source);
      return declared ? [] : [`${e.field}: ${identifier} は ${e.file} に宣言されていない`];
    });
    expect(offenders).toEqual([]);
  });

  it('免除は名指ししたファイルに実在する（腐った file 名を残さない）', () => {
    const offenders = EXEMPT_TBODY.filter(
      (e) => !platformFiles().some((f) => f.name === e.file && tbodyBlocks(f.source).some((b) => b.includes(e.field))),
    ).map((e) => `${e.file}: ${e.field}`);
    expect(offenders).toEqual([]);
  });
});
