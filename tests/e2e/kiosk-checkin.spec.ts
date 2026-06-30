import { test, expect } from './kiosk-fixtures';

/**
 * QR 読み取りチェックインの iPad viewport smoke test (issue #98, increment 1)。
 *
 * inc1 は注入 scanner の mock 既定でフロー UI を確認する（実カメラ読み取りは #65 / inc2）。
 * 受付待機 → QR で受付 → 受付方法選択 → カメラ権限確認 → 読み取り の導線が iPad で
 * 開始でき、カメラ拒否で通常受付へフォールバックできることを確認する。
 */

test('待機画面から QR 受付の導線が表示される', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('start-checkin')).toBeVisible();
});

test('QR 受付 → 受付方法選択 → カメラ権限確認 → 読み取り へ進める', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();

  // 受付方法選択（QR / 通常受付）。
  await expect(page.getByTestId('method-qr')).toBeVisible();
  await expect(page.getByTestId('method-manual')).toBeVisible();
  await page.getByTestId('method-qr').click();

  // カメラ権限確認 UI。
  await expect(page.getByTestId('camera-grant')).toBeVisible();
  await page.getByTestId('camera-grant').click();

  // QR 読み取り画面（mock scanner 起動中）。
  await expect(page.getByTestId('checkin-scanning')).toBeVisible();
});

test('カメラ拒否でも通常受付へフォールバックできる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();

  // カメラを使わない → cameraError。
  await page.getByTestId('camera-deny').click();
  await expect(page.getByTestId('checkin-error-cameraError')).toBeVisible();

  // 通常受付へフォールバックできる。
  await expect(page.getByTestId('checkin-error-manual')).toBeVisible();
  await page.getByTestId('checkin-error-manual').click();

  // 通常受付（手入力）の待機画面へ戻る。
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('受付方法選択から直接通常受付へ切り替えられる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-manual').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});
