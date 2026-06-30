import { test, expect, type Page } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 受付履歴・監査ログの E2E (issue #19)。
 * 受付フローの結果が管理画面 /admin/receptions に記録されることを確認する。
 * in-memory ストアはサーバープロセス共有のため、件数ではなく行の存在で検証する。
 */

async function runReception(page: Page, staffTestId: string) {
  await page.goto('/kiosk');
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
  await runReception(page, 'staff-staff-suzuki');
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
