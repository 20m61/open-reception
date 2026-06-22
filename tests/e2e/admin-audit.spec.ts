import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 管理操作の監査ログ E2E (issue #22)。
 * 監査ログは追記専用のため、並行実行でも「該当 action が存在する」で検証する。
 */

test('部署作成が監査ログに記録される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.request.post('/api/admin/departments', { data: { name: `監査部-${Date.now()}` } });

  const res = await page.request.get('/api/admin/audit');
  expect(res.ok()).toBeTruthy();
  const audit = (await res.json()) as { items: { action: string; actor: string }[] };
  expect(audit.items.some((a) => a.action === 'department.created' && a.actor === 'admin')).toBe(true);
});

test('端末失効が監査ログに記録される', async ({ page }) => {
  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/kiosks', { data: { displayName: 'audit-kiosk' } });
  const kiosk = (await created.json()) as { id: string };
  await page.request.post(`/api/admin/kiosks/${kiosk.id}/revoke`);

  const res = await page.request.get('/api/admin/audit');
  const audit = (await res.json()) as { items: { action: string; targetId?: string }[] };
  expect(audit.items.some((a) => a.action === 'kiosk.revoked' && a.targetId === kiosk.id)).toBe(true);
});

test('監査ログページが表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.request.post('/api/admin/departments', { data: { name: `監査表示-${Date.now()}` } });
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
});

test('監査フィルタ状態が URL に反映され、リロードで復元される（#94）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.request.post('/api/admin/departments', { data: { name: `URL状態-${Date.now()}` } });
  await page.goto('/admin/audit');

  // 操作種別フィルタを選ぶと URL クエリに反映される。
  await page.getByTestId('audit-filter-action').selectOption('department.created');
  await expect(page).toHaveURL(/[?&]action=department\.created/);

  // リロードしても URL からフィルタ状態が復元される（URL が真実源）。
  await page.reload();
  await expect(page.getByTestId('audit-filter-action')).toHaveValue('department.created');
  await expect(page).toHaveURL(/[?&]action=department\.created/);

  // 条件クリアで URL からも除かれる。
  await page.getByTestId('audit-filter-reset').click();
  await expect(page).not.toHaveURL(/action=/);
});

test('監査ログは未認証だと 401', async ({ page }) => {
  const res = await page.request.get('/api/admin/audit');
  expect(res.status()).toBe(401);
});
