import { test, expect } from './kiosk-fixtures';

/**
 * Kiosk 統合 inc1 の iPad viewport smoke test (issue #96 / #79 / #100 / #101 / #102)。
 *
 * 既存スタンドアロン部品（サイネージ・カスタムフロー・来訪検知・退館）を中核 KioskFlow へ
 * フォールバック付きで配線したことを確認する。テスト環境ではカスタムフロー/サイネージは
 * 未設定（空）が既定のため、ここでは **非破壊（既定フローへフォールバック）** と
 * **退館チェックアウト導線** を検証する。サイネージ有/カスタムフロー有の分岐ロジックは
 * ユニット（src/components/kiosk/integration.test.ts）で検証している。
 */

test('待機画面は既定の受付フローへフォールバックする（非破壊）', async ({ page }) => {
  await page.goto('/kiosk');
  // フロー未設定でも従来どおり受付開始/QR 受付の導線が出る。
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('start-checkin')).toBeVisible();
});

test('待機画面から既定の目的選択へ進める（カスタムフロー無効時）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  // 既定の RECEPTION_PURPOSES（面会など）の目的選択が出る。
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
});

test('待機画面に退館チェックアウト導線があり /kiosk/checkout へ遷移する', async ({ page }) => {
  await page.goto('/kiosk');
  const link = page.getByTestId('kiosk-checkout-link');
  await expect(link).toBeVisible();
  await link.click();
  // CheckoutLink は選択中 locale を `?locale=` で引き継ぐ（#327）ため末尾アンカーは張らない。
  await expect(page).toHaveURL(/\/kiosk\/checkout(\?|$)/);
  // 自己特定 再設計後の識別画面（#328）: 退館 QR / 退館コード入力が出る。
  await expect(page.getByTestId('checkout-token')).toBeVisible();
  await expect(page.getByTestId('checkout-code')).toBeVisible();
  await expect(page.getByTestId('checkout-resolve-submit')).toBeVisible();
});
