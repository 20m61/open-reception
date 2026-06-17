import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 管理画面の認可境界 E2E (issue #24)。
 * 未認証では管理画面/APIにアクセスできず、ログイン後にアクセスできることを確認する。
 */

test('未認証では /admin がログインへリダイレクトされる', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByTestId('admin-login-submit')).toBeVisible();
});

test('未認証の管理 API は 401 を返す', async ({ page }) => {
  const res = await page.request.get('/api/admin/receptions');
  expect(res.status()).toBe(401);
});

test('誤ったパスワードのログインは拒否される', async ({ page }) => {
  const res = await page.request.post('/api/admin/login', { data: { password: 'wrong' } });
  expect(res.status()).toBe(401);
});

test('ログイン後は管理画面と管理 API にアクセスできる', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

  const res = await page.request.get('/api/admin/receptions');
  expect(res.ok()).toBeTruthy();
});

test('kiosk API は認証なしで利用できる（公開）', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/directory');
  expect(res.ok()).toBeTruthy();
});
