import { test, expect } from './kiosk-fixtures';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin } from './helpers';

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

test('受付の確認画面に critical な a11y 違反がない（呼び出し直前・安全上重要）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});

test('iPad 横置きの待機画面に critical な a11y 違反がない', async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 810 });
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});

test('大型横画面の待機画面に critical な a11y 違反がない', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});

test('モーション割り当て画面のフォーム要素にアクセシブルな名前がある', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/motions');
  // 各 select に aria-label を付与済み。select-name（critical）が出ないことを保証する。
  await expect(page.getByTestId('motion-table')).toBeVisible();
  expect(await criticalViolations(page)).toEqual([]);
});
