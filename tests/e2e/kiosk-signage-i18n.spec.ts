import { test, expect } from '@playwright/test';

/**
 * 待機サイネージ (SignageDisplay) の i18n スモーク (issue #327 2nd increment)。
 *
 * 2026-07-11 UI レビューで見つかった「English 選択時の待機画面に日本語のままの導線が残る」
 * 問題は、退館チェックアウト導線（#327 1st increment で対応済み）だけでなく、待機サイネージの
 * 未設定フォールバック CTA（「画面をタップして受付を開始」）にも同種の翻訳漏れがあった
 * （常に DEFAULT_LOCALE=ja で固定表示・選択中言語に非連動）。
 *
 * `/kiosk/signage` はスタンドアロンの待機ルート（kiosk セッション不要、KioskFlow に組み込まれない
 * 独立ページ）で、サイネージ項目が未設定の既定状態ではフォールバック表示になる。CheckoutLink /
 * CheckoutFlow と同じ `?locale=` クエリ規約で表示言語を検証できる。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

test('/kiosk/signage は既定 (ja) でフォールバック文言が日本語表示される', async ({ page }) => {
  await page.goto('/kiosk/signage');

  await expect(page.getByTestId('signage-fallback')).toBeVisible();
  await expect(page.getByTestId('signage-start')).toHaveText('画面をタップして受付を開始');
  await expect(page.getByTestId('signage-start')).toHaveAttribute('lang', 'ja');
});

test('/kiosk/signage?locale=en はフォールバック CTA が英語になり、日本語が露出しない', async ({
  page,
}) => {
  await page.goto('/kiosk/signage?locale=en');

  const fallback = page.getByTestId('signage-fallback');
  await expect(fallback).toBeVisible();

  const startButton = page.getByTestId('signage-start');
  await expect(startButton).toHaveText('Tap the screen to start check-in');
  await expect(startButton).toHaveAttribute('lang', 'en');

  // 挨拶（welcome.title 再利用）も英語で、フォールバック全体に CJK が露出しない。
  const fallbackText = await fallback.innerText();
  expect(CJK_PATTERN.test(fallbackText), `未翻訳の CJK が残っている: ${fallbackText}`).toBe(false);

  const startText = await startButton.innerText();
  expect(CJK_PATTERN.test(startText), `未翻訳の CJK が残っている: ${startText}`).toBe(false);
});

test('/kiosk/signage?locale=zh はフォールバック CTA が中国語になる', async ({ page }) => {
  await page.goto('/kiosk/signage?locale=zh');

  await expect(page.getByTestId('signage-start')).toHaveText('请触摸屏幕开始登记');
  await expect(page.getByTestId('signage-start')).toHaveAttribute('lang', 'zh');
});

test('タップで /kiosk へ遷移する動作は locale クエリに関わらず維持される（非破壊）', async ({
  page,
}) => {
  await page.goto('/kiosk/signage?locale=en');
  await page.getByTestId('signage-start').click();
  await expect(page).toHaveURL(/\/kiosk$/);
});
