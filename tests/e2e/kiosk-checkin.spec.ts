import { test, expect, expectCheckinState } from './kiosk-fixtures';
import { openMoreIdleActions } from './helpers';

/**
 * QR 読み取りチェックインの iPad viewport smoke test (issue #98, increment 1)。
 *
 * **注記の訂正 (2026-07-31)**: 「inc1 は注入 scanner の mock 既定で確認する」と書かれていたが、
 * e2e は scanner を注入しておらず（`kiosk-fixtures.ts` は kiosk セッションだけを張る）、
 * **実 `CameraQrScanner` が動いている**。注入経路は `?debugScanPayload=`（#363）で、
 * この spec は使っていない。
 *
 * **再訂正 (第 92 wave)**: 上に「headless でも getUserMedia は成功するので `scanning` は
 * 安定状態」と書いたのは**誤り**だった（1 点サンプリングによる誤結論）。素の headless では
 * `scanning` は**約 2 秒の過渡状態**で、その後 `cameraError` に落ちる。決定的にするために
 * `playwright.config.ts` でフェイクカメラを与えている。詳細は `kiosk-fixtures.ts` の
 * `expectCheckinState` の doc を参照。
 * 受付待機 → QR で受付 → 受付方法選択 → カメラ権限確認 → 読み取り の導線が iPad で
 * 開始でき、カメラ拒否で通常受付へフォールバックできることを確認する。
 */

test('待機画面から QR 受付の導線が表示される', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await openMoreIdleActions(page);
  await expect(page.getByTestId('start-checkin')).toBeVisible();
});

test('QR 受付 → 受付方法選択 → カメラ権限確認 → 読み取り へ進める', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();

  // 受付方法選択（QR / 通常受付）。
  await expect(page.getByTestId('method-qr')).toBeVisible();
  await expect(page.getByTestId('method-manual')).toBeVisible();
  await page.getByTestId('method-qr').click();

  // カメラ権限確認 UI。
  await expect(page.getByTestId('camera-grant')).toBeVisible();
  await page.getByTestId('camera-grant').click();

  // QR 読み取り画面。**e2e に mock scanner は無く実 CameraQrScanner が動く**
  // （この注記は「mock scanner 起動中」と事実に反していた）。状態を先に表明して、
  // 失敗時に実際の状態が名指しされるようにする（kiosk-fixtures の expectCheckinState 参照）。
  await expectCheckinState(page, 'scanning');
  await expect(page.getByTestId('checkin-scanning')).toBeVisible();
});

test('カメラ拒否でも通常受付へフォールバックできる', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
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
  await openMoreIdleActions(page);
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-manual').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});
