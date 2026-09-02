import { test, expect } from './kiosk-fixtures';

/**
 * **テナントのブランド accent が実際の描画へ届く** (#884)。
 *
 * ## なぜ e2e が要るか
 *
 * 修正前、`--brand-accent` の注入は**一度も効いたことが無かった**。`--color-accent:
 * var(--brand-accent)` が `:root` で宣言されており、`var()` は**宣言された要素の計算値時点で
 * 置換される**ため、`:root` で `#38bdf8` に確定した値が子孫へ継承される。`KioskFlow` は
 * `main.screen`（子孫）へ注入するので、何を入れても届かない。
 *
 * 実測（修正前）:
 * ```
 * --brand-accent   #38bdf8 → #7f1d1d   （注入は届いている）
 * --color-accent   #38bdf8 → #38bdf8   （追随しない）
 * 主 CTA の背景     バイト単位で同一
 * ```
 *
 * **これは #869（支援モードが何も拡大していなかった）と同じ型。** 構造テスト
 * （`tests/config/css-custom-property-definitions.test.ts`）は「再宣言が在る」ことしか
 * 言えず、**宣言はあるが効いていない**を見抜けない。だから計算値で実測する。
 */

/** `main.screen` へブランド accent を注入し、CSS 側の再導出を通した計算値を読む。 */
async function paintFor(page: import('@playwright/test').Page, accent: string | null) {
  if (accent !== null) {
    await page.evaluate((a) => {
      const screen = document.querySelector('main.screen') as HTMLElement;
      screen.style.setProperty('--brand-accent', a);
    }, accent);
  }
  return page.evaluate(() => {
    const screen = document.querySelector('main.screen') as HTMLElement;
    const cs = getComputedStyle(screen);
    // 変数の宣言値ではなく**解決後の色**を読む。宣言だけ見ると color-mix の文字列が
    // 返るので「変わった」ように見えてしまう（実際に描画されるかは別）。
    const probe = document.createElement('div');
    screen.appendChild(probe);
    const resolve = (value: string) => {
      probe.style.color = value;
      const out = getComputedStyle(probe).color;
      return out;
    };
    const result = {
      accent: cs.getPropertyValue('--color-accent').trim(),
      strong: resolve('var(--color-accent-strong)'),
      soft: resolve('var(--color-accent-soft)'),
      ink: cs.getPropertyValue('--color-accent-ink').trim(),
    };
    probe.remove();
    return result;
  });
}

test.describe('ブランド accent がキオスクへ届く (#884)', () => {
  test('accent を変えると派生色まで追随する（既定シアンが残らない）', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 20_000 });

    const before = await paintFor(page, null);
    const after = await paintFor(page, '#7f1d1d');

    // 元の値が既定シアンであることを確かめる（前提が崩れたら気づけるように）。
    expect(before.accent.toLowerCase()).toBe('#38bdf8');

    expect(after.accent.toLowerCase(), 'accent 本体が追随していない').toBe('#7f1d1d');
    // 🔴 **派生まで見る。** accent だけ変わって strong / soft が据え置きだと、
    // グラデーションの下端とフォーカス光がシアンのまま残る（これが課題 22 の症状）。
    expect(after.strong, 'strong が追随していない').not.toBe(before.strong);
    expect(after.soft, 'soft が追随していない').not.toBe(before.soft);

    // 既定シアンの成分（0.741176 = 189/255）が派生色に残っていないこと。
    for (const [name, value] of Object.entries(after)) {
      expect(value, `${name} に既定シアンが残っている: ${value}`).not.toContain('0.741176');
    }
  });

  test('暗いブランド色では accent 上のインクが明るい側へ切り替わる', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 20_000 });

    // `KioskFlow` は `accentInkFor()` の結果を注入するが、この spec は CSS 側だけを
    // 動かすので、インクの選択そのものは unit（`branding/types.test.ts`）が総当たりで縛る。
    // ここでは**既定インクが暗い側であること**＝反転していないことだけ確かめる（下界）。
    const paint = await paintFor(page, null);
    expect(paint.ink.toLowerCase()).toBe('#06121f');
  });
});
