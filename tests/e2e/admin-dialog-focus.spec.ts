import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 管理画面のモーダルが**キーボードで閉じ込められる** (#890 / 課題 15)。
 *
 * `DevicesManager` の受付 URL 発行ダイアログは `role="dialog" aria-modal="true"` を宣言しながら
 * autoFocus / focus trap / Escape / focus 復帰の**どれも持っていなかった**。キーボード利用者は
 * ダイアログの外へタブで出て、背後の一覧を操作できてしまう —— しかもそこは
 * **「再表示できない」受付 URL** を出す画面である。
 *
 * ## なぜ構造テストだけでは足りないか
 *
 * `tests/config/admin-a11y-structure.test.ts` は「共有フックを通している」ことしか言えない。
 * **フックを呼んでいるのに効いていない**（ref が別の要素に付いている・条件が反転している）
 * 状態は見抜けない。実際にキーを送って、フォーカスがどこに居るかを読む。
 */
test.describe('管理: モーダルのフォーカス管理 (#890)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/devices');
    await expect(page.getByTestId('device-reissue').first()).toBeVisible({ timeout: 20_000 });
  });

  /** いまフォーカスがある要素が、ダイアログの内側か。 */
  const focusInsideDialog = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="device-reissue-dialog"]');
      return dialog !== null && dialog.contains(document.activeElement);
    });

  test('開いたらフォーカスがダイアログ内へ移る', async ({ page }) => {
    await page.getByTestId('device-reissue').first().click();
    await expect(page.getByTestId('device-reissue-dialog')).toBeVisible();
    expect(await focusInsideDialog(page), '開いてもフォーカスが外に居る').toBe(true);
  });

  test('Tab を繰り返してもダイアログの外へ出ない', async ({ page }) => {
    await page.getByTestId('device-reissue').first().click();
    await expect(page.getByTestId('device-reissue-dialog')).toBeVisible();

    // 中の操作要素数より多く回して、確実に端を跨がせる。
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      expect(await focusInsideDialog(page), `Tab ${i + 1} 回目で外へ出た`).toBe(true);
    }
    // 逆方向も端で折り返す。
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInsideDialog(page), `Shift+Tab ${i + 1} 回目で外へ出た`).toBe(true);
    }
  });

  test('Escape で閉じ、開いた要素へフォーカスが戻る', async ({ page }) => {
    const opener = page.getByTestId('device-reissue').first();
    await opener.click();
    await expect(page.getByTestId('device-reissue-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('device-reissue-dialog')).toHaveCount(0);

    // **戻すところまで見る。** 戻さないとフォーカスが body へ落ち、キーボード利用者は
    // 一覧の先頭から辿り直すことになる。
    const backOnOpener = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.getAttribute('data-testid') ?? active?.tagName ?? null;
    });
    expect(backOnOpener, 'フォーカスが開いた要素へ戻っていない').toBe('device-reissue');
  });

  test('ダイアログには名前が付いている（aria-labelledby が見出しを指す）', async ({ page }) => {
    await page.getByTestId('device-reissue').first().click();
    const named = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="device-reissue-dialog"]');
      const id = dialog?.getAttribute('aria-labelledby');
      if (!id) return null;
      return document.getElementById(id)?.textContent?.trim() ?? null;
    });
    expect(named, 'aria-labelledby が見出しを指していない').toBeTruthy();
  });
});
