import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * エリア切替導線の**肯定側** (#423「developer ロール時のみ platform への切替導線を表示」)。
 *
 * developer 専用サーバ（`platform-developer` project）で走る。否定側は既定サーバの
 * `area-switch.spec.ts`。**押して実際に着くところまで**見る — リンクが在ることと行けることは
 * 別で、`/platform` はサーバ側ガードで弾かれ得る（非 developer ならここで `/admin` に戻される）。
 *
 * 戻り導線は無条件に出す設計。行き止まりを作らない方へ倒している（`domain/auth/area-switch.ts`）。
 */
test.describe('エリア切替導線: developer は admin ⇄ platform を行き来できる (#423)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('admin から platform へ行ける', async ({ page }) => {
    await page.goto('/admin');
    const link = page.getByTestId('area-switch');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('data-target-area', 'platform');

    await link.click();
    await expect(page).toHaveURL(/\/platform$/);
    // 実際に platform が描かれている（admin へ戻されていない）。
    await expect(page.getByTestId('area-label')).toHaveText('プラットフォーム運用');
  });

  test('platform から admin へ戻れる', async ({ page }) => {
    await page.goto('/platform');
    const link = page.getByTestId('area-switch');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('data-target-area', 'admin');

    await link.click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByTestId('area-label')).toHaveText('テナント管理');
  });

  test('往復しても現在地表示が現在のエリアを指す', async ({ page }) => {
    // 共有 layout の props はクライアント遷移で更新されない（第 87 wave）。エリアを跨ぐ遷移は
    // layout ごと入れ替わるので更新されるはずだが、**思い込みではなく実際に往復して確かめる**。
    await page.goto('/admin');
    await page.getByTestId('area-switch').click();
    await expect(page.getByTestId('area-label')).toHaveText('プラットフォーム運用');
    await page.getByTestId('area-switch').click();
    await expect(page.getByTestId('area-label')).toHaveText('テナント管理');
    await expect(page.getByTestId('area-switch')).toHaveAttribute('data-target-area', 'platform');
  });
});
