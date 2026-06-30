import { test, expect, type Page } from './kiosk-fixtures';

/**
 * iPad 受付 MVP フローの E2E smoke test (issue #21)。
 * 成功 / 未応答 / 失敗の分岐と、完了後の待機画面復帰を検証する。
 *
 * 呼び出し結果は担当者の mockCallOutcome で決定的に分岐する (issue #20):
 *   staff-sato       → connected
 *   staff-suzuki     → timeout（未応答）
 *   staff-takahashi  → failed
 */

async function advanceToConfirm(page: Page, staffTestId: string, name = '来客 一郎') {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId(staffTestId).click();
  await page.getByTestId('visitor-name').fill(name);
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
}

test('呼び出し成功フロー: 接続 → 完了 → 待機画面へ復帰', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato');
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();

  await expect(page.getByTestId('completed')).toBeVisible();
  // 自動リセットで待機画面へ戻る。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });
});

test('未応答フロー: timeout → 代替導線 → 待機画面へ復帰', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-suzuki');
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible();
  await page.getByTestId('use-fallback').click();
  await expect(page.getByTestId('fallback')).toBeVisible();

  await page.getByTestId('fallback-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('失敗フロー: failed でも代替導線で詰まらない', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-takahashi');
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-failed')).toBeVisible();
  await page.getByTestId('result-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('部署選択でも呼び出しできる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-delivery').click();
  await page.getByTestId('dept-dept-sales').click();
  await page.getByTestId('visitor-name').fill('配送 太郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
});

test('担当者検索で絞り込める', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-search').fill('すずき');
  await expect(page.getByTestId('staff-staff-suzuki')).toBeVisible();
  await expect(page.getByTestId('staff-staff-sato')).toHaveCount(0);
});

test('確認画面から修正に戻れる', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato', '修正 花子');
  await expect(page.getByTestId('confirm-name')).toHaveText('修正 花子');
  await page.getByTestId('confirm-back').click();
  await expect(page.getByTestId('visitor-name')).toHaveValue('修正 花子');
});
