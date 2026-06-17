import { expect, type Page } from '@playwright/test';

/**
 * 管理セッションを確立する (issue #24)。
 * page.request は BrowserContext と cookie を共有するため、以降の page.goto も認証済みになる。
 * ローカル/CI では ADMIN_PASSWORD 既定値を使う。
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post('/api/admin/login', { data: { password: 'open-reception' } });
  expect(res.ok()).toBeTruthy();
}
