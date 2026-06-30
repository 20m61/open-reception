import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 部署・担当者管理の E2E (issue #3, #25, #26)。
 * 共有 in-memory ストア汚染を避けるため、seed データは変更せず一意名で新規追加・操作する。
 */

function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

test('部署を追加すると一覧と受付端末に反映される', async ({ page }) => {
  const name = uniq('部署');
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  // クライアントの読み込み完了（=ハイドレーション済み）を待ってから入力する。
  await expect(page.getByTestId('dept-row').first()).toBeVisible();
  await page.getByTestId('dept-name-input').fill(name);
  await page.getByTestId('dept-add').click();

  const row = page.getByTestId('dept-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);

  // 受付端末のディレクトリにも現れる（コード変更なしで反映）。
  const res = await page.request.get('/api/kiosk/directory');
  expect(res.ok()).toBeTruthy();
  const dir = (await res.json()) as { departments: { name: string }[] };
  expect(dir.departments.some((d) => d.name === name)).toBe(true);
});

test('追加した部署を無効化できる', async ({ page }) => {
  const name = uniq('無効化部署');
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-row').first()).toBeVisible();
  await page.getByTestId('dept-name-input').fill(name);
  await page.getByTestId('dept-add').click();

  const row = page.getByTestId('dept-row').filter({ hasText: name });
  await expect(row).toContainText('有効');
  await row.getByTestId('dept-toggle').click();
  await expect(row).toContainText('無効');
});

test('担当者を追加して無効化できる', async ({ page }) => {
  const name = uniq('担当');
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  await expect(page.getByTestId('staff-row').first()).toBeVisible();
  await page.getByTestId('staff-name-input').fill(name);
  await page.getByTestId('staff-add').click();

  const row = page.getByTestId('staff-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('有効');

  await row.getByTestId('staff-toggle').click();
  await expect(row).toContainText('無効');
});

test('受付端末は管理画面の部署・担当者を取得して表示する', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // seed の担当者・部署が API 経由で表示される。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
});
