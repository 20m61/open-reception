import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 各画面のスクリーンショット取得（手動検証/レビュー用・回帰比較ではない）(品質ゲート整備)。
 * 本番ビルド（npm run start）に対して受付端末・管理画面の主要画面を撮影し screenshots/ に保存する。
 * 対象 URL は playwright の baseURL（既定はローカル本番、PLAYWRIGHT_BASE_URL で実環境にも向けられる）。
 */
const DIR = 'screenshots';

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

test.describe('受付端末（kiosk）', () => {
  test.use({ viewport: { width: 810, height: 1080 } });

  test('kiosk 主要画面', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible();
    await shot(page, 'kiosk-01-idle');

    await page.getByTestId('start-reception').click();
    await expect(page.getByTestId('custom-purpose-view').or(page.getByTestId('kiosk-purpose'))).toBeVisible({ timeout: 10_000 }).catch(() => {});
    await shot(page, 'kiosk-02-purpose');

    // 目的選択 → 担当者選択（既定フロー）。
    await page.getByTestId('purpose-meeting').click().catch(() => {});
    await shot(page, 'kiosk-03-target');

    await page.getByTestId('staff-staff-sato').click().catch(() => {});
    await shot(page, 'kiosk-04-visitor-info');

    await page.getByTestId('visitor-name').fill('来客 太郎').catch(() => {});
    await page.getByTestId('to-confirm').click().catch(() => {});
    await shot(page, 'kiosk-05-confirm');
  });
});

test.describe('管理画面（admin）', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  const PAGES: Array<[string, string]> = [
    ['admin-01-dashboard', '/admin'],
    ['admin-02-receptions', '/admin/receptions'],
    ['admin-03-reservations', '/admin/reservations'],
    ['admin-04-sites', '/admin/sites'],
    ['admin-05-devices', '/admin/devices'],
    ['admin-06-call-routes', '/admin/call-routes'],
    ['admin-07-departments', '/admin/departments'],
    ['admin-08-staff', '/admin/staff'],
    ['admin-09-reception-flows', '/admin/reception-flows'],
    ['admin-10-ai-guidance', '/admin/ai-guidance'],
    ['admin-11-signage', '/admin/signage'],
    ['admin-12-usage', '/admin/usage'],
    ['admin-13-costs', '/admin/costs'],
    ['admin-14-audit', '/admin/audit'],
    ['admin-15-security', '/admin/security'],
    ['admin-16-auth', '/admin/auth'],
  ];

  test('admin 主要画面', async ({ page }) => {
    test.setTimeout(180_000);
    await loginAsAdmin(page);
    for (const [name, path] of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(500);
      await shot(page, name);
    }
  });

  test('platform 主要画面', async ({ page }) => {
    await loginAsAdmin(page);
    for (const [name, path] of [
      ['platform-01-dashboard', '/platform'],
      ['platform-02-tenants', '/platform/tenants'],
    ] as Array<[string, string]>) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      await shot(page, name);
    }
  });
});
