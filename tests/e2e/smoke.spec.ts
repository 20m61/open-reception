import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 基盤の smoke test (issue #9)。
 * 受付端末 (/kiosk) と管理画面 (/admin) の入口が分離して表示できることを確認する。
 * 受付フロー本体の smoke test は issue #21 で拡充する。
 */
test('トップから受付端末と管理画面の入口が表示される', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'open-reception' })).toBeVisible();
  await expect(page.getByRole('link', { name: /受付端末/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /管理画面/ })).toBeVisible();
});

test('受付待機画面が表示される', async ({ page }) => {
  await page.goto('/kiosk');
  // タッチファースト再設計 (#121): 待機画面は用件選択のクイックアクションを大きく出す。
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('管理ダッシュボードが表示される（要ログイン）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
});
