import { test, expect } from './kiosk-fixtures';

/**
 * 受付進行中に常設される「お知らせ」の i18n スモーク (issue #327 follow-up)。
 *
 * 通信断バナーは逃げ道バーと同じく**画面分岐より手前**に置かれ、受付のどの局面でも出る
 * 来訪者向け要素。しかも通信断は「失敗時フォールバック」の入口そのもので、English を
 * 選んだ来訪者が呼び出し中に回線が揺れると**日本語の警告だけが出る**状態だった。
 * #455 で逃げ道バーを多言語化した際、独立レビューが残存リスクとして指摘した箇所。
 *
 * 通信断は heartbeat の失敗で判定される。既定 30 秒周期では E2E が待てないため、
 * 既存の `?inactivityMs=` / `?callingStageMs=` と同じ流儀で `?heartbeatMs=` を使う。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

test('通信断バナーは既定 (ja) で日本語表示される（回帰の固定）', async ({ page }) => {
  await page.goto('/kiosk?heartbeatMs=300');
  await expect(page.getByTestId('start-reception')).toBeVisible();

  // 最初の heartbeat が通って待機画面が開いたあとで疎通を落とす。
  await page.route('**/api/kiosk/heartbeat*', (route) => route.abort());

  const banner = page.getByTestId('kiosk-offline');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('通信が不安定です');
});

test('English を選ぶと通信断バナーも英語になり、日本語が露出しない', async ({ page }) => {
  await page.goto('/kiosk?heartbeatMs=300');
  await page.getByRole('button', { name: 'English' }).click();

  await page.route('**/api/kiosk/heartbeat*', (route) => route.abort());

  const banner = page.getByTestId('kiosk-offline');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveAttribute('lang', 'en');

  const text = await banner.innerText();
  expect(CJK_PATTERN.test(text), `未翻訳の CJK が残っている: ${text}`).toBe(false);
  expect(text).toContain('connection');
});
