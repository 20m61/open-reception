import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * アクセシビリティ支援モードのテナント/サイト設定 E2E (issue #321 AC「テナント/サイト設定で
 * 機能ごとに有効/無効を切替可能に」)。
 *
 * `voice-store` は単一シングルトン（テナント単位の共有設定）のため、ここでの PUT は
 * グローバル状態を書き換える。他 kiosk テストと並行実行すると a11y パネルの見え方に関する
 * アサーションを汚染しうるため、playwright.config.ts の `flow-mutation` project（本 suite の
 * 全 project 完了後に単独実行）に隔離している。各テストは最後に必ず既定（全モード有効）へ戻す。
 */

const ALL_ENABLED = { largeText: true, highContrast: true, lowReach: true, simpleJapanese: true };

// この 3 テストは全て同じグローバル a11yModesEnabled を書き換えるため、並行実行（既定の
// fullyParallel）だと互いの PUT が競合しフレークする。ファイル内は直列実行に固定する。
test.describe.configure({ mode: 'serial' });

test('無効化したモードは受付端末の支援モードパネルに出ない', async ({ page }) => {
  await loginAsAdmin(page);
  try {
    const put = await page.request.put('/api/admin/voice', {
      data: { a11yModesEnabled: { largeText: true, highContrast: false, lowReach: true, simpleJapanese: false } },
    });
    expect(put.ok()).toBeTruthy();

    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await expect(page.getByTestId('a11y-menu-panel')).toBeVisible();

    // 有効なモードは出る。
    await expect(page.getByTestId('a11y-font-scale-1.3')).toBeVisible();
    await expect(page.getByTestId('a11y-lowreach-toggle')).toBeVisible();
    // 無効化したモードはパネルに出ない。
    await expect(page.getByTestId('a11y-contrast-toggle')).toHaveCount(0);
    await expect(page.getByTestId('a11y-simple-japanese-toggle')).toHaveCount(0);
  } finally {
    // 他の a11y e2e（全モード有効を前提）を汚染しないよう必ず既定へ戻す。
    await page.request.put('/api/admin/voice', { data: { a11yModesEnabled: ALL_ENABLED } });
  }
});

test('全モードを無効化すると支援モードボタン自体が出ない', async ({ page }) => {
  await loginAsAdmin(page);
  try {
    const put = await page.request.put('/api/admin/voice', {
      data: {
        a11yModesEnabled: { largeText: false, highContrast: false, lowReach: false, simpleJapanese: false },
      },
    });
    expect(put.ok()).toBeTruthy();

    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible();
    await expect(page.getByTestId('a11y-menu-button')).toHaveCount(0);
  } finally {
    await page.request.put('/api/admin/voice', { data: { a11yModesEnabled: ALL_ENABLED } });
  }
});

test('管理画面のアクセシビリティ支援モード欄で有効/無効を切り替えて保存できる', async ({ page }) => {
  await loginAsAdmin(page);
  try {
    await page.goto('/admin/voice');
    await expect(page.getByTestId('voice-a11y-large-text')).toBeVisible();
    await expect(page.getByTestId('voice-a11y-high-contrast')).toBeVisible();
    await expect(page.getByTestId('voice-a11y-low-reach')).toBeVisible();
    await expect(page.getByTestId('voice-a11y-simple-japanese')).toBeVisible();

    // 既定は全チェック済み（未設定=全モード有効）。
    await expect(page.getByTestId('voice-a11y-high-contrast')).toBeChecked();

    await page.getByTestId('voice-a11y-high-contrast').uncheck();
    await page.getByTestId('voice-save').click();
    await expect(page.getByTestId('voice-saved')).toBeVisible();

    // リロードしても保存内容が反映される。
    await page.reload();
    await expect(page.getByTestId('voice-a11y-high-contrast')).not.toBeChecked();
    await expect(page.getByTestId('voice-a11y-large-text')).toBeChecked();
  } finally {
    await page.request.put('/api/admin/voice', { data: { a11yModesEnabled: ALL_ENABLED } });
  }
});
