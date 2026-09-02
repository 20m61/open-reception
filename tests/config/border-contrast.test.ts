import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 操作要素の境界コントラスト (#918 / 課題 24・WCAG 1.4.11 Non-text Contrast)。
 *
 * 🔴 **比率を書き写さない。** 「3.05:1 である」と数値を置くテストは、面やトークンを
 * 変えた瞬間に**古い数値を守り続ける**。ここでは CSS から実値を読み、相対輝度を計算して
 * 「3:1 以上」を主張する。面が増えたら自動で対象になる。
 *
 * 適用範囲は**操作要素の境界**であって、装飾的な仕切りではない。2 つのトークンは
 * 実際にそう使い分けられている（`--color-border-strong` = ボタン・入力欄・タブ、
 * `--color-border` = カードの縁・表の行区切り）。装飾側まで上げると密度が壊れるうえ、
 * WCAG も求めていない。
 */

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** `:root` から CSS 変数の生値を読む（最初の宣言＝既定テーマ）。 */
function cssVar(name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(CSS);
  if (!m?.[1]) throw new Error(`--${name} が globals.css に無い`);
  return m[1].trim();
}

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) throw new Error(`hex ではない: ${value}`);
  const n = m[1];
  return [
    Number.parseInt(n.slice(0, 2), 16),
    Number.parseInt(n.slice(2, 4), 16),
    Number.parseInt(n.slice(4, 6), 16),
  ];
}

function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (!m) throw new Error(`rgba ではない: ${value}`);
  return {
    rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
    alpha: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** 半透明の前景を不透明な背景へ合成する。 */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round((fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha))) as
    unknown as Rgb;
}

/** WCAG 2.x の相対輝度。 */
function luminance([r, g, b]: Rgb): number {
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** 罫線が乗りうる不透明な面。 */
const SURFACES = ['color-bg', 'color-bg-2', 'color-surface', 'color-surface-2'] as const;

/** WCAG 1.4.11: 操作要素の境界は 3:1 以上。 */
const MIN_UI_CONTRAST = 3;

describe('操作要素の境界コントラスト (#918 / 課題 24)', () => {
  it.each(SURFACES)('--color-border-strong は %s に対して 3:1 以上', (surfaceVar) => {
    const { rgb, alpha } = parseRgba(cssVar('color-border-strong'));
    const surface = parseHex(cssVar(surfaceVar));
    const effective = composite(rgb, alpha, surface);
    expect(contrast(effective, surface)).toBeGreaterThanOrEqual(MIN_UI_CONTRAST);
  });

  /*
   * 下界その 1。上は「border-strong を真っ白にする」で最大化して通せるが、それは
   * **装飾の仕切りまで白くする**のとは違う。装飾側が巻き添えで上がっていないことを見る。
   * ここが無いと「全部の罫線を濃くする」が緑になり、密度の破壊を検出できない。
   */
  it('下界: 装飾用の --color-border は上げない', () => {
    const { alpha } = parseRgba(cssVar('color-border'));
    const strong = parseRgba(cssVar('color-border-strong'));
    expect(alpha).toBeLessThan(strong.alpha);
    // 表の行区切りやカードの縁が「線」として主張しすぎない範囲に留める。
    expect(alpha).toBeLessThan(0.2);
  });

  /*
   * 下界その 2。トークンの比率を満たしても、**操作要素が弱い方を使っていたら**意味が無い。
   * `.kiosk-quick-actions__more`（QR / 配送 / その他への入口）が実際にそうだった。
   */
  it.each([
    '.btn--secondary',
    '.btn--ghost',
    '.input',
    '.target-tabs__tab',
    '.kiosk-quick-actions__more',
    '.satisfaction-feedback__rating-btn',
    '.a11y-menu__button',
  ])('下界: 操作要素 %s は強い方のトークンを使う', (selector) => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, `${selector} が globals.css に無い`).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at));
    const border = /border(?:-color)?:[^;]*var\(--color-border(-strong)?\)/.exec(block);
    expect(border, `${selector} が罫線トークンを使っていない`).not.toBeNull();
    expect(border?.[1], `${selector} が装飾用の --color-border を使っている`).toBe('-strong');
  });
});
