import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 呼び出し先・代替担当者の E2E (issue #26)。
 * 新規担当者で検証して seed を汚染しない。優先順位（配列順）と代替担当者を確認する。
 */

test('呼び出し先を設定し、優先順位（配列順）が反映される', async ({ page }) => {
  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/staff', {
    data: { displayName: `CT-${Math.random().toString(36).slice(2, 7)}`, departmentId: 'dept-sales' },
  });
  const staff = (await created.json()) as { id: string };

  const res = await page.request.patch(`/api/admin/staff/${staff.id}`, {
    data: {
      callTargets: [
        { type: 'phone', value: '03-1111-2222' },
        { type: 'email', value: 'x@example.com' },
      ],
    },
  });
  const body = (await res.json()) as { callTargets: { type: string; priority: number }[] };
  expect(body.callTargets.map((t) => [t.type, t.priority])).toEqual([
    ['phone', 0],
    ['email', 1],
  ]);
});

test('代替担当者を設定できる', async ({ page }) => {
  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/staff', {
    data: { displayName: `FB-${Math.random().toString(36).slice(2, 7)}`, departmentId: 'dept-sales' },
  });
  const staff = (await created.json()) as { id: string };

  const res = await page.request.patch(`/api/admin/staff/${staff.id}`, {
    data: { fallbackStaffIds: ['staff-sato'] },
  });
  const body = (await res.json()) as { fallbackStaffIds: string[] };
  expect(body.fallbackStaffIds).toEqual(['staff-sato']);
});

test('担当者編集パネルで呼び出し先を追加できる', async ({ page }) => {
  const name = `編集-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  await expect(page.getByTestId('staff-row').first()).toBeVisible();
  await page.getByTestId('staff-name-input').fill(name);
  await page.getByTestId('staff-add').click();

  const row = page.getByTestId('staff-row').filter({ hasText: name });
  await row.getByTestId('staff-edit').click();
  await expect(page.getByTestId('staff-editor')).toBeVisible();
  await page.getByTestId('ct-add').click();
  await expect(page.getByTestId('ct-row').first()).toBeVisible();
});
