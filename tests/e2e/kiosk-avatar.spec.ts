import { test, expect } from './kiosk-fixtures';

/**
 * アバター案内の状態同期ゲート E2E (issue #123 / Epic #119)。
 *
 * 検証する不変条件:
 *  - 待機の初期体験で「AI受付」であることを字幕で明示する（音声が無くても字幕で伝わる）。
 *  - アバター案内は主要操作（受付開始）を妨げない（pointer-events:none）。
 */

test('待機画面でアバター字幕が AI 受付であることを明示する', async ({ page }) => {
  await page.goto('/kiosk');

  const subtitle = page.getByTestId('avatar-subtitle');
  await expect(subtitle).toBeVisible();
  await expect(subtitle).toContainText('AI受付');

  // アバターは操作を妨げない：そのまま受付開始へ進める。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toHaveCount(0);
});
