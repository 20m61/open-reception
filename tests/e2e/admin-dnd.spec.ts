import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 部署 DnD 並び替えの E2E (issue #25)。
 * DnD UI が呼ぶ reorder API を直接検証し（決定的）、UI 行が draggable であることも確認する。
 */

test('reorder API で部署の表示順を一括変更できる', async ({ page }) => {
  await loginAsAdmin(page);
  const before = await page.request.get('/api/admin/departments');
  const ids = ((await before.json()) as { items: { id: string }[] }).items.map((d) => d.id);
  const reversed = [...ids].reverse();

  const res = await page.request.post('/api/admin/departments/reorder', { data: { orderedIds: reversed } });
  expect(res.ok()).toBeTruthy();
  const after = ((await res.json()) as { id: string }[]).map((d) => d.id);
  expect(after).toEqual(reversed);

  // 後続テストへの影響を避けるため元の順序へ戻す。
  await page.request.post('/api/admin/departments/reorder', { data: { orderedIds: ids } });
});

test('部署一覧の行はドラッグ可能', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  const row = page.getByTestId('dept-row').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('draggable', 'true');
});
