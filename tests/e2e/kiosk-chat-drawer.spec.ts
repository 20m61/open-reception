import { test, expect } from './kiosk-fixtures';

/**
 * Chat-assisted ドロワーの配線・非遮蔽ゲート E2E (issue #124 / Epic #119)。
 *
 * 検証する不変条件:
 *  - 操作中の状態では補助ドロワー（控えめな「お困りですか？」）を開閉できる。
 *  - ドロワーを開いても、安全な逃げ道（キャンセル等の主要操作）が隠れずタッチできる。
 *  - 待機/終端ではドロワーを出さない（PII/会話履歴を残さない設計）。
 */

test('待機（idle）では補助ドロワーを表示しない', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('kiosk-chat-drawer')).toHaveCount(0);
});

test('操作中はドロワーを開閉でき、開いても逃げ道（キャンセル）を隠さない', async ({ page }) => {
  await page.goto('/kiosk');
  // 担当者選択（ドロワー利用可能な操作中の状態）まで進める。
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  const drawer = page.getByTestId('kiosk-chat-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('data-open', 'false');

  // 控えめな呼びかけ FAB から開く。
  await page.getByRole('button', { name: 'お困りですか？' }).click();
  await expect(drawer).toHaveAttribute('data-open', 'true');

  // ドロワーが開いていても安全な逃げ道「キャンセル」はタッチできる（遮蔽されていれば
  // Playwright のクリックが対象に届かず失敗する）。押すと待機へ戻る。
  await page.getByTestId('escape-cancel').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});
