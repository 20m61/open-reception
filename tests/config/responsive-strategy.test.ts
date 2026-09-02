import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 画面幅への応答が 3 系統目を生やさないようにする (#920 / 課題 30)。
 *
 * 受付端末と管理画面は**別の道具**を使っている。競合ではなく分業で、理由は
 * `docs/component-catalog.md` §5.5 にある（要約: 受付端末はアスペクト比で役割配置を
 * 決める必要があり、その結果を JS 側のレイヤ（VRM の視線など）とも共有する。
 * 管理画面はサイドバーを畳むかどうかだけなので media query 1 本で足りる）。
 *
 * 🔴 **監査が本当に心配しているのは「統一されていないこと」ではなく
 * 「3 つ目が黙って生えること」**である。統一を強制するのではなく、
 * 既存の 2 系統から外れた分岐が増えないことを縛る。
 */

const ROOT = process.cwd();

function sources(dir: string, exts: readonly string[]): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(rel, exts);
    if (!e.isFile() || !exts.some((x) => e.name.endsWith(x))) return [];
    return e.name.includes('.test.') ? [] : [rel];
  });
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 注記を落としてから走査する。
 *
 * 🔴 最初の版は `globals.css` の**コメント**（「1280〜1600px の 3 ペインレイアウトで…」）を
 * しきい値の直書きとして誤検出した。本リポジトリが繰り返し踏んでいる型なので、
 * 走査対象からコメントを外す。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 認めている幅ベースのブレークポイント。増やすなら §5.5 を更新してからここへ足す。 */
const ALLOWED_BREAKPOINTS: readonly string[] = ['max-width: 900px'];

/** 受付端末のしきい値を宣言してよい唯一の場所。 */
const LAYOUT_MODULE = 'src/components/kiosk/layout.ts';

/** viewport を直接読んでよい唯一の場所（`resolveKioskLayout` へ委譲する）。 */
const VIEWPORT_READER = 'src/components/kiosk/useKioskLayout.ts';

describe('画面幅への応答 (#920 / 課題 30)', () => {
  it('幅ベースの @media は台帳のものだけ', () => {
    const found = sources('src', ['.css']).flatMap((rel) =>
      [...read(rel).matchAll(/@media[^{]*?((?:min|max)-width:\s*[^)]+)\)/g)].map((m) => ({
        rel,
        bp: String(m[1]).trim(),
      })),
    );
    const unexpected = found.filter((f) => !ALLOWED_BREAKPOINTS.includes(f.bp));
    expect(unexpected.map((f) => `${f.rel}: ${f.bp}`)).toEqual([]);
  });

  it('受付端末のしきい値は layout.ts の外に出ない', () => {
    /*
     * 🔴 **裸の数値も見る。** 最初の版は `LARGE_DISPLAY_MIN_WIDTH` か `1600px` しか見ておらず、
     * 別ファイルに `const LARGE = 1600;` と書き直す変異が**生存した**（実測）。
     * しきい値が散るのは「定数名で書かれたとき」ではなく「値を書き写されたとき」なので、
     * 値そのものを見る（`1600` は現状 layout.ts 以外に出現しないことを確認済み）。
     */
    const offenders = [...sources('src', ['.ts', '.tsx']), ...sources('src', ['.css'])]
      .filter((rel) => rel !== LAYOUT_MODULE)
      .filter((rel) => /\bLARGE_DISPLAY_MIN_WIDTH\b|\b1600\b/.test(stripComments(read(rel))))
      // import して使うのは構わない。**値を書き直している**ものだけを落とす。
      .filter((rel) => !/from '[^']*kiosk\/layout'/.test(read(rel)))
      .map((rel) => relative('src', rel));
    expect(offenders).toEqual([]);
  });

  it('幅による分岐は 1 箇所だけ', () => {
    /*
     * `window.innerWidth` をあちこちで読むと、しきい値が散るより先に
     * **判定の意味**が散る（ある画面は幅だけ、別の画面はアスペクト比、のように）。
     *
     * 🔴 **`innerHeight` は対象にしない。** 最初の版は含めていて `KioskFlow` を誤検出した ——
     * あれは幅で分岐しているのではなく、**sticky な逃げ道バーの実位置を測っている**
     * （#788 で固定値をやめた箇所そのもの）。測ることと分岐することは別で、
     * 前者まで止めると 4K で壊れた実装へ逆戻りさせることになる。
     */
    const offenders = sources('src', ['.ts', '.tsx'])
      .filter((rel) => rel !== VIEWPORT_READER)
      .filter((rel) => /window\.innerWidth|matchMedia\(/.test(stripComments(read(rel))))
      .map((rel) => relative('src', rel));
    expect(offenders).toEqual([]);
  });

  /*
   * 下界。上の 3 本は「CSS 側の配置を全部消す」「レイアウト判定をやめる」で通る。
   * 分業の**両側が実在している**ことを縛る。
   */
  it('下界: 受付端末側は CSS が [data-kiosk-layout] で配置している', () => {
    const css = read('src/app/globals.css');
    expect([...css.matchAll(/data-kiosk-layout=/g)].length).toBeGreaterThanOrEqual(20);
  });

  it('下界: 役割プロファイルの判定が実在する', () => {
    const layout = read(LAYOUT_MODULE);
    expect(layout).toContain('export function resolveKioskLayout');
    // アスペクト比の分岐（media query で書けない理由そのもの）が残っていること。
    expect(layout).toMatch(/width\s*>=\s*height/);
  });

  it('下界: 分業の理由が文書に書かれている', () => {
    // 規律だけ残って理由が消えると、次に触る人は「統一されていない」としか読めない。
    const doc = read('docs/component-catalog.md');
    expect(doc).toContain('画面幅への応答は 2 系統ある');
    expect(doc).toContain('data-kiosk-layout');
    expect(doc).toContain('max-width: 900px');
  });
});
