import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * アクセシビリティ自動チェック (issue #7)。
 * axe で主要画面を検査し、critical（最重大）違反が無いことを保証する。
 * serious 以下は段階的に改善する対象として許容する。
 */
async function criticalViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'critical');
}

test('トップに critical な a11y 違反がない', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'open-reception' })).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});

test('受付待機画面に critical な a11y 違反がない', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});

test('管理ログインに critical な a11y 違反がない', async ({ page }) => {
  await page.goto('/admin/login');
  await expect(page.getByTestId('admin-login-submit')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});
