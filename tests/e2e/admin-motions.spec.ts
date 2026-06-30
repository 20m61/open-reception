import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * モーション割り当ての E2E (issue #31)。
 * 受付端末は状態に応じた motion キーを公開し（VRM レンダラ #5 が消費）、
 * 未設定/失敗でも受付画面は壊れないことを確認する。
 */

test('モーション割り当てページが表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/motions');
  await expect(page.getByTestId('motion-table')).toBeVisible();
  await expect(page.getByTestId('motion-idle')).toBeVisible();
});

test('モーション割り当て API は未認証だと 401', async ({ page }) => {
  const res = await page.request.get('/api/admin/motions');
  expect(res.status()).toBe(401);
});

test('受付端末は状態に応じた motion キーを公開する', async ({ page }) => {
  await page.goto('/kiosk');
  const main = page.locator('main[data-kiosk-motion]');
  await expect(main).toHaveAttribute('data-kiosk-motion', 'idle');
  await page.getByTestId('start-reception').click();
  await expect(main).toHaveAttribute('data-kiosk-motion', 'greeting');
});

test('受付端末モーション API は default fallback 構造を返す', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/motions');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { motions: Record<string, string> };
  expect(typeof body.motions).toBe('object');
});
