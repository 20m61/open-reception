import { test, expect } from '@playwright/test';
import { establishKioskSession, loginAsAdmin } from './helpers';

/**
 * 受付端末アクセス制御の E2E (issue #23)。
 * 並行実行を壊さないため pinRequired は true にしない（PIN 必須の判定は unit test で検証）。
 */

test('kiosk セッション未保持で /kiosk は未エンロール案内を出す（受付フローを出さない, #239）', async ({
  page,
}) => {
  // セッション未確立のまま /kiosk へ直接到達（pinRequired は既定 false）。
  await page.goto('/kiosk');
  // 受付フローではなく未エンロール案内が出る（heartbeat 後にゲートが閉じる）。
  await expect(page.getByTestId('kiosk-unenrolled')).toBeVisible({ timeout: 15_000 });
  // 受付待機画面の開始導線は出ない（フローへ入れない）。
  await expect(page.getByTestId('start-reception')).toHaveCount(0);
});

test('pinRequired=false では authorize がセッションを発行しない（403, #244）', async ({ page }) => {
  // PIN 不要運用では PIN 自己許可を認めない（誰でも authorize でゲートを回避できないように）。
  const auth = await page.request.post('/api/kiosk/authorize', { data: { pin: '0000', kioskId: 'kiosk-dev' } });
  expect(auth.status()).toBe(403);

  const status = await page.request.get('/api/kiosk/session-status');
  const body = (await status.json()) as { authorized: boolean };
  expect(body.authorized).toBe(false);
});

test('kiosk セッション（エンロール由来）では管理 API を操作できない', async ({ page, browser }) => {
  await establishKioskSession(page, browser);
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
  await expect(page.getByTestId('emergency-section')).toBeVisible();
});

test('緊急停止は確認ステップを挟む（実行はしない＝他テストを止めない）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/security');
  await page.getByTestId('emergency-stop').click();
  // 確認ボタンが出るが、停止せず「やめる」で取り消す（グローバル状態は変えない）。
  await expect(page.getByTestId('emergency-confirm')).toBeVisible();
  await page.getByTestId('emergency-cancel').click();
  await expect(page.getByTestId('emergency-stop')).toBeVisible();
});

test('緊急停止 API は emergencyStop を返す（false のまま）', async ({ page }) => {
  await loginAsAdmin(page);
  const res = await page.request.put('/api/admin/security', { data: { emergencyStop: false } });
  const body = (await res.json()) as { emergencyStop: boolean };
  expect(body.emergencyStop).toBe(false);
});
