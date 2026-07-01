import { test, expect } from './kiosk-fixtures';

/**
 * 受付端末 heartbeat の E2E (issue #30)。
 * 端末有効性・許可状態を返し、長期表示中の変化を検知できることを確認する。
 */

test('有効端末の heartbeat は active=true', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/heartbeat?kioskId=kiosk-dev');
  expect(res.ok()).toBeTruthy();
  const hb = (await res.json()) as { active: boolean; serverTime: string };
  expect(hb.active).toBe(true);
  expect(typeof hb.serverTime).toBe('string');
});

test('未登録端末の heartbeat は active=false', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/heartbeat?kioskId=unknown-device');
  const hb = (await res.json()) as { active: boolean };
  expect(hb.active).toBe(false);
});

test('エンロール済み端末の heartbeat は authorized が true（#239/#244）', async ({ page }) => {
  // フィクスチャがエンロールで kiosk セッションを確立済み。heartbeat がそれを authorized で反映する。
  const res = await page.request.get('/api/kiosk/heartbeat?kioskId=kiosk-dev');
  const hb = (await res.json()) as { authorized: boolean };
  expect(hb.authorized).toBe(true);
});

test('受付端末は heartbeat 稼働中も待機画面を表示し続ける', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  // オフライン表示は出ていない（通信正常）。
  await expect(page.getByTestId('kiosk-offline')).toHaveCount(0);
});
