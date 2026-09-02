import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * platform 主要画面のスクリーンショット取得（`capture-screens.spec.ts` から分離）。
 *
 * 分離の理由: platform は developer ロール専用で、既定の e2e サーバの password ログインは
 * developer にならない。同居していた頃はリダイレクト先の **admin を platform-*.png として
 * 撮り続けていた**（撮影は成功するので誰も気づけない）。developer 専用サーバへ向ける
 * `platform-developer` project からのみ実行する（`playwright.config.ts`）。
 *
 * 撮るだけの spec は「撮れた＝正しい」と読めてしまうため、**撮る前に platform に居ることを
 * 表明する**。これが本ファイルの存在理由の半分（#423）。
 */
const DIR = 'screenshots';

test('platform 主要画面', async ({ page }) => {
  await loginAsAdmin(page);

  await page.goto('/platform/tenants');
  // platform 固有の要素。admin へリダイレクトされていればここで落ちる。
  await expect(
    page.getByTestId('platform-tenant-switcher'),
    'platform へ到達できていない（admin を platform として撮る事故の再発）',
  ).toBeVisible();

  for (const [name, path] of [
    ['platform-01-dashboard', '/platform'],
    ['platform-02-tenants', '/platform/tenants'],
  ] as Array<[string, string]>) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(new RegExp(`${path}/?$`));
    await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
  }
});
