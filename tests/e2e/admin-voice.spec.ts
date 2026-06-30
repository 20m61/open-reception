import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 音声設定の E2E (issue #28)。
 * 案内文言はグローバル設定のため、kiosk への反映は「文言が表示される（非空）」で検証し、
 * 具体的な文字列の上書きはしない（並行テスト汚染回避）。
 */

test('音声設定は未認証だと 401', async ({ page }) => {
  const res = await page.request.get('/api/admin/voice');
  expect(res.status()).toBe(401);
});

test('管理者は音声設定を取得・更新できる', async ({ page }) => {
  await loginAsAdmin(page);
  const get = await page.request.get('/api/admin/voice');
  expect(get.ok()).toBeTruthy();

  // 応答のエコーで検証（グローバル文言は変えない）。
  const put = await page.request.put('/api/admin/voice', { data: { rate: 9, volume: -1 } });
  const body = (await put.json()) as { rate: number; volume: number };
  expect(body.rate).toBe(2); // クランプ
  expect(body.volume).toBe(0);
});

test('音声設定ページが表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/voice');
  await expect(page.getByTestId('voice-tts')).toBeVisible();
  await expect(page.getByTestId('voice-guidance-idle')).toBeVisible();
});

test('受付端末は案内文言 API を取得し待機画面に表示する', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/voice');
  const body = (await res.json()) as { guidanceIdle: string };
  expect(typeof body.guidanceIdle).toBe('string');
  expect(body.guidanceIdle.length).toBeGreaterThan(0);

  await page.goto('/kiosk');
  await expect(page.getByTestId('idle-guidance')).toBeVisible();
  await expect(page.getByTestId('idle-guidance')).not.toBeEmpty();
});
