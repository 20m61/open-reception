import { test, expect } from '@playwright/test';

/**
 * 受付端末のレイアウトプロファイル E2E (issue #124 / Epic #119)。
 * 主要 viewport（iPad 縦/横・4K/大型横画面）で data-kiosk-layout が期待どおり切り替わり、
 * 待機画面の主要操作（クイックアクション）が表示されることを確認する。
 */
const KIOSK_MAIN = 'main[data-kiosk-layout]';

test('iPad 縦置きは ipad-portrait プロファイル', async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await page.goto('/kiosk');
  await expect(page.locator(KIOSK_MAIN)).toHaveAttribute('data-kiosk-layout', 'ipad-portrait');
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('iPad 横置きは ipad-landscape プロファイル', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 810 });
  await page.goto('/kiosk');
  await expect(page.locator(KIOSK_MAIN)).toHaveAttribute('data-kiosk-layout', 'ipad-landscape');
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('4K/大型横画面は large-display プロファイル', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/kiosk');
  await expect(page.locator(KIOSK_MAIN)).toHaveAttribute('data-kiosk-layout', 'large-display');
  await expect(page.getByTestId('start-reception')).toBeVisible();
});
