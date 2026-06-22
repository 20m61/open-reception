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

test('ダッシュボードに利用量・予想コスト概況と詳細への導線がある（#86）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByText('今月の予想コスト（概算）')).toBeVisible();
  // 概況カードから利用量/コスト詳細へ誘導する（集約 API・準備中ではない）。
  await expect(page.locator('a[href="/admin/usage"]').first()).toBeVisible();
  await expect(page.locator('a[href="/admin/costs"]').first()).toBeVisible();
});
