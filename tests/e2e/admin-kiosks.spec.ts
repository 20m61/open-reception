import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 受付端末管理・失効の E2E (issue #18)。
 * seed 端末 kiosk-dev は変更せず、新規登録した端末で失効を検証する（汚染回避）。
 */

test('受付端末を登録して一覧に表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/kiosks');
  await expect(page.getByTestId('kiosk-row').first()).toBeVisible();
  const name = `端末-${Math.random().toString(36).slice(2, 7)}`;
  await page.getByTestId('kiosk-name-input').fill(name);
  await page.getByTestId('kiosk-add').click();
  await expect(page.getByTestId('kiosk-row').filter({ hasText: name })).toHaveCount(1);
});

test('失効した端末は config で active=false になる', async ({ page }) => {
  await loginAsAdmin(page);
  // 端末を登録し、その id で検証する（kiosk-dev には影響させない）。
  const created = await page.request.post('/api/admin/kiosks', { data: { displayName: 'revoke-target' } });
  const kiosk = (await created.json()) as { id: string };

  const before = await page.request.get(`/api/kiosk/config?kioskId=${kiosk.id}`);
  expect(((await before.json()) as { active: boolean }).active).toBe(true);

  await page.request.post(`/api/admin/kiosks/${kiosk.id}/revoke`);

  const after = await page.request.get(`/api/kiosk/config?kioskId=${kiosk.id}`);
  expect(((await after.json()) as { active: boolean }).active).toBe(false);
});

test('seed 端末 kiosk-dev は有効なまま', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/config?kioskId=kiosk-dev');
  expect(((await res.json()) as { active: boolean }).active).toBe(true);
});

test('受付端末管理ページは未認証だとログインへリダイレクト', async ({ page }) => {
  await page.goto('/admin/kiosks');
  await expect(page).toHaveURL(/\/admin\/login$/);
});
