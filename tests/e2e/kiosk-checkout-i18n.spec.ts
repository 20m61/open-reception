import { test, expect, type Page } from './kiosk-fixtures';

/**
 * English ロケールでの退館チェックアウト導線スモーク (issue #327)。
 *
 * 検証する不変条件:
 *  - 待機画面で English を選ぶと、退館チェックアウトへの導線（CheckoutLink）も
 *    English になる（従来は「退館チェックアウト」のまま残っていた = H2 バグ）。
 *  - `/kiosk/checkout` は選択中の locale を `?locale=` で引き継ぎ、見出し・説明・
 *    ラベル・ボタン・空状態・エラー文言まで含め、画面上のテキストに日本語（CJK）が
 *    一切露出しない。
 *  - 直接 `/kiosk/checkout` へ来た場合も LanguageSwitcher で English に切り替えられる。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

async function switchToEnglish(page: Page) {
  await page.getByRole('button', { name: 'English' }).click();
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

test('English で /kiosk/checkout に遷移し、全文言が英語で日本語が露出しない', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await switchToEnglish(page);

  await page.getByTestId('kiosk-checkout-link').click();
  await expect(page).toHaveURL(/\/kiosk\/checkout\?locale=en/);

  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  await expect(page.getByText('Enter your reception number')).toBeVisible();
  await expect(page.getByTestId('checkout-submit')).toHaveText('Check out');

  // 在館者ゼロ（新規シード端末）想定: 空状態も英語。
  await expect(page.getByTestId('checkout-empty')).toHaveText('No visitors are currently on site.');

  // LanguageSwitcher の他言語ボタンは仕様上「常に自言語の固定ラベル」（翻訳に依存しない、
  // 読めない言語でも自分の言語を選べるようにするための意図的な非翻訳 UI）。CJK 露出チェックは
  // その分を除外し、実際の画面文言（翻訳対象）のみを検証する。
  const nativeLanguageLabels = ['日本語', '한국어', '中文'];
  const bodyText = await page.locator('main').innerText();
  const translatableText = nativeLanguageLabels.reduce(
    (text, label) => text.replaceAll(label, ''),
    bodyText,
  );
  expect(CJK_PATTERN.test(translatableText), `未翻訳の CJK 文字列が残っている: ${translatableText}`).toBe(
    false,
  );
});

test('存在しない受付番号での退館試行のエラー文言も英語（CJK が露出しない）', async ({ page }) => {
  await page.goto('/kiosk/checkout?locale=en');

  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  await page.getByTestId('checkout-stay-id').fill('stay-does-not-exist');
  await page.getByTestId('checkout-submit').click();

  const errorMessage = page.getByTestId('checkout-error');
  await expect(errorMessage).toBeVisible();
  const text = await errorMessage.innerText();
  expect(CJK_PATTERN.test(text), `エラー文言に CJK が露出: ${text}`).toBe(false);
  expect(text.length).toBeGreaterThan(0);
});

test('/kiosk/checkout へ直接来ても LanguageSwitcher で English に切替えられる', async ({ page }) => {
  await page.goto('/kiosk/checkout');
  // 既定 locale (ja) で表示される。
  await expect(page.getByRole('heading', { name: '退館チェックアウト', level: 1 })).toBeVisible();

  await switchToEnglish(page);

  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  await expect(page.getByTestId('checkout-submit')).toHaveText('Check out');
});
