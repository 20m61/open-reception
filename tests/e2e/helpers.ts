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

/**
 * 受付端末（kiosk）セッションを確立する (issue #239)。/kiosk はセッション必須になったため、
 * `/kiosk` を直接開いて受付フローを検証/撮影する前に呼ぶ。既定 PIN `0000`・kioskId `kiosk-dev` で
 * 許可 API を叩く（pinRequired に依らず成立）。page.request は BrowserContext と cookie を共有する。
 */
export async function establishKioskSession(page: Page): Promise<void> {
  await page.request.post('/api/kiosk/authorize', {
    data: { pin: '0000', kioskId: 'kiosk-dev' },
  });
}
