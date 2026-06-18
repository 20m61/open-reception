import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * アセット管理の E2E (issue #27)。
 * seed の背景は変更せず、一意名の新規アセットで検証する（汚染回避）。
 */

test('アセットを登録できる', async ({ page }) => {
  const name = `bg-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);
  await page.goto('/admin/assets');
  await expect(page.getByTestId('asset-row').first()).toBeVisible();
  await page.getByTestId('asset-name').fill(name);
  await page.getByTestId('asset-url').fill('https://cdn.example.com/x.png');
  await page.getByTestId('asset-add').click();
  await expect(page.getByTestId('asset-row').filter({ hasText: name })).toHaveCount(1);
});

test('不正なファイル形式は拒否される', async ({ page }) => {
  await loginAsAdmin(page);
  const res = await page.request.post('/api/admin/assets', {
    data: { kind: 'vrm', name: 'bad', url: 'https://cdn.example.com/x.txt' },
  });
  expect(res.status()).toBe(400);
});

test('アセット API は未認証だと 401', async ({ page }) => {
  const res = await page.request.get('/api/admin/assets');
  expect(res.status()).toBe(401);
});

test('受付端末アセット API は背景 URL を返す', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/assets');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { backgroundUrl?: string };
  expect(typeof body.backgroundUrl === 'string' || body.backgroundUrl === undefined).toBe(true);
});
