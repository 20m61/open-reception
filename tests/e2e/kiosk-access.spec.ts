import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 受付端末アクセス制御の E2E (issue #23)。
 * 並行実行を壊さないため pinRequired は true にしない（PIN 必須の判定は unit test で検証）。
 */

test('受付端末の許可 API でセッションを確立できる', async ({ page }) => {
  const auth = await page.request.post('/api/kiosk/authorize', { data: { pin: '0000', kioskId: 'kiosk-dev' } });
  expect(auth.ok()).toBeTruthy();

  const status = await page.request.get('/api/kiosk/session-status');
  const body = (await status.json()) as { authorized: boolean };
  expect(body.authorized).toBe(true);
});

test('kiosk セッションでは管理 API を操作できない', async ({ page }) => {
  await page.request.post('/api/kiosk/authorize', { data: { pin: '0000' } });
  // kiosk_session は持つが admin_session は持たない → 401。
  const res = await page.request.get('/api/admin/security');
  expect(res.status()).toBe(401);
});

test('セキュリティ設定は未認証だと 401', async ({ page }) => {
  const res = await page.request.get('/api/admin/security');
  expect(res.status()).toBe(401);
});

test('管理者はセキュリティ設定を取得・更新できる（PIN は無効化したまま）', async ({ page }) => {
  await loginAsAdmin(page);
  const get = await page.request.get('/api/admin/security');
  expect(get.ok()).toBeTruthy();

  const put = await page.request.put('/api/admin/security', {
    data: { pinRequired: false, ipAllowlist: [] },
  });
  const body = (await put.json()) as { pinRequired: boolean };
  expect(body.pinRequired).toBe(false);
});

test('セキュリティ設定ページが表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/security');
  await expect(page.getByTestId('security-pin-required')).toBeVisible();
});
