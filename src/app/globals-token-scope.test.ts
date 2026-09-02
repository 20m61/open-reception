import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 管理画面が受付端末向けサイズを継承しないことを構造で担保する (#501)。
 *
 * **色ではなくサイズが問題だった。** kiosk と admin は意図的に同じダークテーマを共有して
 * いるので、色を分離しても同じ値を 2 箇所に持つだけになる。一方サイズは kiosk 固有の制約で、
 * 実際に波及事故が起きている:
 *
 * > 管理ナビはページ本文の巨大な受付端末向けフォント（`--font-body` = 20px）をそのまま
 * > 継承していたため、"受付端末（拠点別）" のような長いラベルが語の途中で折り返っていた
 * >   — `src/components/admin/nav-link-style.ts`（#330 item4）
 *
 * **方向が重要: 既定（:root）は受付端末向けのまま据え置き、admin/platform 側が下げる。**
 * 逆（:root を下げて kiosk が上書き）にすると kiosk の実寸が変わってしまう。mobile 相当の
 * 環境では Chrome の text autosizing により **`rem` の基準である `html` の font-size 自体が
 * 周囲のフォント指定に応じて膨らむ**（実測: html 16px → 20px）。:root を下げると拡大率が
 * 変わり、kiosk 側で「同じ 1.25rem」に戻しても実寸が一致しない（VRT が検出）。
 */
const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function blockOf(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`セレクタが無い: ${selector}`);
  const end = CSS.indexOf('\n}', start);
  return CSS.slice(start, end);
}

/**
 * そのブロックが宣言しているカスタムプロパティの値。無ければ null。
 * 動的 RegExp を使わず行走査で取る（semgrep の detect-non-literal-regexp を避けるため。
 * 抑制コメントで黙らせるより、そもそも正規表現を組み立てない方が素直）。
 */
function declaredValue(selector: string, name: string): string | null {
  for (const line of blockOf(selector).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${name}:`)) continue;
    const value = trimmed.slice(name.length + 1).split(';')[0];
    return value?.trim() ?? null;
  }
  return null;
}

/** 受付端末向けに大きく取るサイズトークン。 */
const SIZE_TOKENS = ['--font-body', '--font-lg', '--font-xl', '--touch-target-min'] as const;

/** 管理画面スコープ。`AdminShell` が `data-area` を出す（admin / platform 共通シェル）。 */
const ADMIN_SCOPE = "[data-area='admin'],\n[data-area='platform']";

describe('デザイントークンのスコープ (#501)', () => {
  /*
   * #869 で倍率の掛け方を直した際、素の基準値（1.25rem 等）は `--font-size-*-base` へ移した。
   * 以前はここで `--font-body` の値に `1.25rem` が**含まれる**ことを見ていたが、基準値が
   * 別トークンへ出た今は、そちらを**厳密一致**で見るほうが強い（`contain` は
   * `11.25rem` のような値も通してしまう）。守っている保証は変わらない ——
   * **既定は受付端末向けの実寸のまま、admin だけが下げる**。
   */
  it('既定(:root)は受付端末向けのまま（kiosk の実寸を動かさない）', () => {
    // ここを下げると text autosizing 経由で rem 基準が動き、kiosk の描画が変わる。
    expect(declaredValue(':root', '--touch-target-min')).toBe('64px');
    expect(declaredValue(':root', '--font-size-body-base')).toBe('1.25rem');
    expect(declaredValue(':root', '--font-size-lg-base')).toBe('1.75rem');
    expect(declaredValue(':root', '--font-size-xl-base')).toBe('2.75rem');
  });

  it('派生トークンは基準値から導出する（基準値を変えれば全部が動く）', () => {
    for (const [token, base] of [
      ['--font-body', '--font-size-body-base'],
      ['--font-lg', '--font-size-lg-base'],
      ['--font-xl', '--font-size-xl-base'],
    ] as const) {
      expect(declaredValue(':root', token), token).toContain(`var(${base})`);
    }
  });

  it('管理画面スコープが全サイズトークンを下げる（継承を断つ）', () => {
    for (const token of SIZE_TOKENS) {
      const value = declaredValue(ADMIN_SCOPE, token);
      expect(value, `${token} が管理画面スコープに無い`).not.toBeNull();
    }
    expect(declaredValue(ADMIN_SCOPE, '--touch-target-min')).toBe('44px');
    expect(declaredValue(ADMIN_SCOPE, '--font-size-body-base')).toBe('1rem');
  });

  it('本文サイズを font-size でも効かせる（変数の再定義だけでは継承が変わらない）', () => {
    // `font-size` は計算値で継承される。`body { font-size: var(--font-body) }` が :root の
    // 値で確定するため、変数を再定義しただけでは管理画面の文字が小さくならない。
    const hasFontSize = blockOf(ADMIN_SCOPE)
      .split('\n')
      .some((line) => line.trim() === 'font-size: var(--font-body);');
    expect(hasFontSize).toBe(true);
  });

  it('管理画面でも文字サイズ拡大(--a11y-font-scale)が効く', () => {
    for (const token of ['--font-body', '--font-lg', '--font-xl'] as const) {
      expect(declaredValue(ADMIN_SCOPE, token), token).toContain('var(--a11y-font-scale)');
    }
  });

  it('管理画面のサイズは受付端末向けより小さい（密度が違う）', () => {
    const kioskTouch = Number(declaredValue(':root', '--touch-target-min')?.replace('px', ''));
    const adminTouch = Number(declaredValue(ADMIN_SCOPE, '--touch-target-min')?.replace('px', ''));
    expect(adminTouch).toBeLessThan(kioskTouch);
    // 44px は WCAG 2.5.5 (Target Size) の最小値。これ以上は下げない。
    expect(adminTouch).toBeGreaterThanOrEqual(44);
  });
});
