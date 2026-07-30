import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * エリア切替導線の**否定側** (#423「developer ロール時のみ platform への切替導線を表示」)。
 *
 * このサーバは既定 `passwordRole=tenant_admin` なので developer ではない。導線は出ない。
 * 肯定側（developer に出る・押すと着く）は developer 専用サーバの
 * `platform-area-switch.spec.ts` にある。**両側を別サーバで固定しないと「常に出る」実装でも
 * 「常に出ない」実装でも片側だけは通ってしまう。**
 *
 * なお導線の非表示は保護ではない（URL は誰でも打てる）。実際のガードは
 * `/platform` へ直接行くと `/admin` へ戻されることで担保されており、それは下の test が見る。
 */
test.describe('エリア切替導線: 非 developer には出ない (#423)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('admin ヘッダに platform への導線が無い', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByTestId('area-label')).toHaveText('テナント管理');
    await expect(page.getByTestId('area-switch')).toHaveCount(0);
  });

  test('URL を直接打っても platform には入れない（導線の非表示は保護ではない）', async ({
    page,
  }) => {
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/admin$/);
  });
});
