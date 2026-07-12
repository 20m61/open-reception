import { test, expect, type Page } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 受付履歴・監査ログの E2E (issue #19)。
 * 受付フローの結果が管理画面 /admin/receptions に記録されることを確認する。
 * in-memory ストアはサーバープロセス共有のため、件数ではなく行の存在で検証する。
 */

async function runReception(page: Page, staffTestId: string, query = '') {
  await page.goto(`/kiosk${query}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId(staffTestId).click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
}

test('呼び出し成功・完了が受付履歴に記録される', async ({ page }) => {
  await runReception(page, 'staff-staff-sato');
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();
  await expect(page.getByTestId('completed')).toBeVisible();

  await loginAsAdmin(page);
  await page.goto('/admin/receptions');
  await expect(page.getByTestId('receptions-table')).toBeVisible();
  await expect(page.getByTestId('reception-row').filter({ hasText: '応答' }).first()).toBeVisible();
});

test('未応答→代替導線の利用が受付履歴に記録される', async ({ page }) => {
  // タイムアウト直前の予告を挟んでから実遷移する (issue #323 AC3)。本番既定（約 30s）を
  // 待たず短縮する（既存 ?inactivityMs= と同じ流儀）。
  await runReception(page, 'staff-staff-suzuki', '?callingStageMs=100&callingNoticeMs=200&callingNoticeHoldMs=100');
  await expect(page.getByTestId('result-timeout')).toBeVisible();
  await page.getByTestId('use-fallback').click();
  await expect(page.getByTestId('fallback')).toBeVisible();

  await loginAsAdmin(page);
  await page.goto('/admin/receptions');
  const fallbackRow = page.getByTestId('reception-row').filter({ hasText: '未応答' }).filter({ hasText: 'あり' });
  await expect(fallbackRow.first()).toBeVisible();
});

test('受付履歴に来訪者の個人情報が表示されない', async ({ page }) => {
  await runReception(page, 'staff-staff-takahashi');
  await expect(page.getByTestId('result-failed')).toBeVisible();

  await loginAsAdmin(page);
  await page.goto('/admin/receptions');
  await expect(page.getByTestId('receptions-table')).toBeVisible();
  await expect(page.getByText('来客 一郎')).toHaveCount(0);
});

test('受付履歴のフィルタ状態が URL に反映され、リロードで復元される（#330 item2）', async ({ page }) => {
  await runReception(page, 'staff-staff-sato');
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();

  await loginAsAdmin(page);
  await page.goto('/admin/receptions');
  await expect(page.getByTestId('receptions-table')).toBeVisible();

  await page.getByTestId('receptions-filter-outcome').selectOption('connected');
  await expect(page).toHaveURL(/[?&]outcome=connected/);

  await page.reload();
  await expect(page.getByTestId('receptions-filter-outcome')).toHaveValue('connected');
  await expect(page).toHaveURL(/[?&]outcome=connected/);

  // 絞り込むと「結果」列は選んだ outcome のみになる。
  const rows = page.getByTestId('reception-row');
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await expect(rows.nth(i)).toContainText('応答');
  }

  await page.getByTestId('receptions-filter-reset').click();
  await expect(page).not.toHaveURL(/outcome=/);
});

test('受付履歴を CSV でエクスポートできる（#330 item2）', async ({ page }) => {
  await runReception(page, 'staff-staff-sato');
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();

  await loginAsAdmin(page);
  await page.goto('/admin/receptions');
  await expect(page.getByTestId('receptions-table')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('receptions-csv-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^receptions-\d{4}-\d{2}-\d{2}\.csv$/);
});
