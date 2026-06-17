import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * CSV インポートの E2E (issue #25, #26)。
 * 一意名で新規追加し、プレビュー→取り込みの差分を検証する（汚染回避）。
 */

test('部署 CSV をプレビューして取り込める', async ({ page }) => {
  const name = `CSV部-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);

  // プレビューは変更しない。
  const preview = await page.request.post('/api/admin/departments/import', {
    data: { csv: `name\n${name}`, mode: 'preview' },
  });
  expect(((await preview.json()) as { created: number }).created).toBe(1);

  // 取り込み後に一覧へ反映される。
  const apply = await page.request.post('/api/admin/departments/import', {
    data: { csv: `name\n${name}`, mode: 'apply' },
  });
  expect(((await apply.json()) as { created: number }).created).toBe(1);

  const list = await page.request.get('/api/admin/departments');
  const items = ((await list.json()) as { items: { name: string }[] }).items;
  expect(items.some((d) => d.name === name)).toBe(true);
});

test('担当者 CSV を取り込める', async ({ page }) => {
  const name = `CSV担当-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);
  const apply = await page.request.post('/api/admin/staff/import', {
    data: { csv: `display_name,department_id\n${name},dept-sales`, mode: 'apply' },
  });
  expect(((await apply.json()) as { created: number }).created).toBe(1);

  const list = await page.request.get('/api/admin/staff');
  const items = ((await list.json()) as { items: { displayName: string }[] }).items;
  expect(items.some((s) => s.displayName === name)).toBe(true);
});

test('CSV インポート UI からプレビューできる', async ({ page }) => {
  const name = `UI部-${Math.random().toString(36).slice(2, 7)}`;
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-row').first()).toBeVisible();
  // CSV インポートは折りたたみ（details）内なので開いてから入力する。
  await page.getByTestId('dept-csv').getByText('CSV インポート').click();
  await page.getByTestId('dept-csv-input').fill(`name\n${name}`);
  await page.getByTestId('dept-csv-preview').click();
  await expect(page.getByTestId('dept-csv-summary')).toContainText('新規 1 件');
});
