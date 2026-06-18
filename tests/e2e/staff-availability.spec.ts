import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 担当者の在席/不在の扱い E2E (issue #26)。
 * 不在担当者は受付画面で呼び出せず、案内が表示される。
 */

test('受付画面で不在の担当者は呼び出せない', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // seed の不在担当者（staff-ono）は「不在」案内が出て選択できない。
  const absent = page.getByTestId('staff-staff-ono');
  await expect(absent).toBeVisible();
  await expect(absent).toHaveAttribute('data-unavailable', 'true');
  await expect(page.getByTestId('staff-staff-ono-absent')).toBeVisible();
});

test('管理画面で担当者を不在に切り替えられる', async ({ page }) => {
  const name = `在席テスト-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  await expect(page.getByTestId('staff-row').first()).toBeVisible();
  await page.getByTestId('staff-name-input').fill(name);
  await page.getByTestId('staff-add').click();

  const row = page.getByTestId('staff-row').filter({ hasText: name });
  await expect(row.getByTestId('staff-availability')).toHaveText('在席');
  await row.getByTestId('staff-availability-toggle').click();
  await expect(row.getByTestId('staff-availability')).toHaveText('不在');
});
