import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * OS 設定の高コントラストに応答する (#907 / 課題 32)。
 *
 * それまで高コントラストの手段は受付端末の支援モードだけで、**管理画面には
 * コントラストを上げる手段が 1 つも無かった**。OS 側で「コントラストを上げる」を
 * 選んでいる利用者に、管理画面は何も応答していなかった。
 *
 * CSS の文面ではなく**実ブラウザの計算値**で見る。`tests/config/contrast-palette-parity.test.ts`
 * が 2 つの入口のパレット一致を静的に縛るのに対し、ここは「実際に効くか」を見る。
 */

/**
 * トークンの値を `#rrggbb` へ正規化する。
 *
 * 本番ビルドの CSS は短縮されるので、ソースに `#ffffff` と書いても
 * ブラウザからは `#fff` で返る。**文字列比較にすると、実装ではなくミニファイアを
 * テストすることになる。**
 */
function normalizeHex(value: string): string {
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : v;
}

/** `rgb(r, g, b)` を輝度へ（0=黒, 1=白）。厳密な WCAG 相対輝度でなく大小比較に使う。 */
function brightness(css: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) return NaN;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test('prefers-contrast: more で管理画面の地色が黒へ落ちる', async ({ page }) => {
  await loginAsAdmin(page);

  await page.emulateMedia({ contrast: 'no-preference' });
  await page.goto('/admin/sites');
  await expect(page.getByTestId('site-name-input')).toBeVisible();
  const before = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('background-color'),
  );

  await page.emulateMedia({ contrast: 'more' });
  const after = await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('background-color'),
  );

  // 既定の地色は真っ黒ではない。high contrast では黒へ落ちる。
  expect(brightness(before)).toBeGreaterThan(0);
  expect(brightness(after)).toBe(0);
});

test('prefers-contrast: more で罫線が白（最大コントラスト）になる', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/sites');
  await expect(page.getByTestId('site-name-input')).toBeVisible();

  await page.emulateMedia({ contrast: 'more' });
  const border = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-border').trim(),
  );
  expect(normalizeHex(border)).toBe('#ffffff');
});

test('下界: 既定（no-preference）では描画が変わらない', async ({ page }) => {
  /*
   * 「常に高コントラスト」にする変異をここで落とす。OS 設定を読んでいない実装は
   * この検査を通れない。
   */
  await loginAsAdmin(page);
  await page.emulateMedia({ contrast: 'no-preference' });
  await page.goto('/admin/sites');
  await expect(page.getByTestId('site-name-input')).toBeVisible();

  const border = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-border').trim(),
  );
  expect(normalizeHex(border)).not.toBe('#ffffff');
});

/*
 * 🔴 **`forced-colors` の e2e は書かない。** 実測すると Chromium の強制配色エミュレーションは
 * **著者の指定に関わらず** border-color を system palette へ置き換える
 * （既定 `rgb(159, 177, 204)` → 強制時 `rgb(96, 0, 0)`、地色も白へ）。つまり
 * 「強制配色で枠が見える」という主張は、`@media (forced-colors: active)` を 1 行も
 * 書いていない main でも通る —— **何も判定していないテストになる。**
 *
 * 最初に書いた版は `border-top-width > 0` を見ており、これはさらに空虚だった
 * （`buttonStyle` が既定で `1px solid transparent` を置いているので常に 1px ある）。
 *
 * 代わりに `tests/config/contrast-palette-parity.test.ts` が**方針**を縛る ——
 * `forced-colors` ブロックが system color を使い、**自前の hex を重ねない**こと
 * （OS が選んだ色を上書きしないのがこの機能の要点で、それは静的に判定できる）。
 */
