import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 退館チェックアウト（自己特定 再設計）の i18n + デザイン統一スモーク (issue #328 / #327)。
 *
 * 検証する不変条件:
 *  - 待機画面で English を選ぶと退館導線（CheckoutLink）も English（#327 の H2 回帰防止）。
 *  - `/kiosk/checkout` は選択中 locale を `?locale=` で引き継ぎ、再設計後の識別画面
 *    （退館 QR / 退館コード + 呼び出し先ラベル / 在館一覧）の全文言が英語で、日本語（CJK）が露出しない。
 *  - kiosk デザインシステムへ統一されている（.screen / 常設の逃げ道バー = start-over）。
 *  - 誤ったコード/ラベルでの退館試行のエラー文言も英語（CJK が露出しない）。
 *  - 退館 QR/URL（`?ct=`）で開いた場合の自動解決エラーも英語で表示される。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

async function switchToEnglish(page: Page) {
  await page.getByRole('button', { name: 'English' }).click();
}

/** 母国語固定ラベル（LanguageSwitcher の意図的な非翻訳 UI）を除いた画面文言に CJK が無いこと。 */
async function expectNoCjkInMain(page: Page) {
  const nativeLanguageLabels = ['日本語', '한국어', '中文'];
  const bodyText = await page.locator('main').innerText();
  const translatableText = nativeLanguageLabels.reduce(
    (text, label) => text.replaceAll(label, ''),
    bodyText,
  );
  expect(CJK_PATTERN.test(translatableText), `未翻訳の CJK が残っている: ${translatableText}`).toBe(false);
}

test('待機画面で English を選ぶと退館チェックアウト導線も English になる', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();

  await switchToEnglish(page);

  const checkoutLink = page.getByTestId('kiosk-checkout-link');
  await expect(checkoutLink).toHaveText('Checkout');
  await expect(checkoutLink).toHaveAttribute('lang', 'en');
  await expect(checkoutLink).toHaveAttribute('href', '/kiosk/checkout?locale=en');
});

test('English の識別画面が英語で表示され、日本語が露出しない（デザイン統一）', async ({ page }) => {
  await page.goto('/kiosk/checkout?locale=en');

  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  // 自己特定の 2 手段が英語で提示される。
  await expect(page.getByRole('heading', { name: 'Check out with QR', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check out with a code', level: 2 })).toBeVisible();
  await expect(page.getByTestId('checkout-resolve-submit')).toHaveText('Continue');
  // 在館者ゼロ（新規シード端末）想定: 空状態も英語。
  await expect(page.getByTestId('checkout-empty')).toHaveText('No visitors are currently on site.');
  // kiosk デザインシステムへ統一: 常設の逃げ道バー。
  await expect(page.getByTestId('checkout-start-over')).toHaveText('Start over');

  await expectNoCjkInMain(page);
});

test('誤った退館コード + 呼び出し先での退館試行はエラー文言が英語（CJK 露出なし）', async ({ page }) => {
  await page.goto('/kiosk/checkout?locale=en');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();

  await page.getByTestId('checkout-code').fill('0000');
  await page.getByTestId('checkout-target-label').fill('Nonexistent Dept');
  await page.getByTestId('checkout-resolve-submit').click();

  const errorMessage = page.getByTestId('checkout-error');
  await expect(errorMessage).toBeVisible();
  const text = await errorMessage.innerText();
  expect(CJK_PATTERN.test(text), `エラー文言に CJK が露出: ${text}`).toBe(false);
  expect(text.length).toBeGreaterThan(0);
});

test('退館 QR/URL（?ct=）で開くと自動解決し、無効 token のエラーも英語', async ({ page }) => {
  await page.goto('/kiosk/checkout?locale=en&ct=invalidtoken000');

  const errorMessage = page.getByTestId('checkout-error');
  await expect(errorMessage).toBeVisible();
  const text = await errorMessage.innerText();
  expect(CJK_PATTERN.test(text), `自動解決エラーに CJK が露出: ${text}`).toBe(false);
});

test('/kiosk/checkout へ直接来ても LanguageSwitcher で English に切替えられる', async ({ page }) => {
  await page.goto('/kiosk/checkout');
  // 既定 locale (ja) で表示される。
  await expect(page.getByRole('heading', { name: '退館チェックアウト', level: 1 })).toBeVisible();

  await switchToEnglish(page);

  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  await expect(page.getByTestId('checkout-resolve-submit')).toHaveText('Continue');
});
