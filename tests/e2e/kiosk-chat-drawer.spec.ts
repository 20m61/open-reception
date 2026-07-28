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

  // ドロワーが開いていても安全な逃げ道「最初に戻る」はタッチできる（遮蔽されていれば
  // Playwright のクリックが対象に届かず失敗する）。押すと待機へ戻る (#325 で cancel→reset へ集約)。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

/**
 * 補助ドロワーの i18n (issue #327 follow-up)。
 *
 * このドロワーは**担当者検索 0 件時の「チャットで相談する」から開く**導線を持つ (#322)。
 * 訳されないと「来訪者が困っている時にだけ日本語が出る」ことになる。
 */
test('English を選ぶと補助ドロワーも英語になり、日本語が露出しない', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 呼びかけ FAB が英語（ja のままなら name で引けない）。
  await page.getByRole('button', { name: 'Need help?' }).click();
  const drawer = page.getByTestId('kiosk-chat-drawer');
  await expect(drawer).toHaveAttribute('data-open', 'true');

  // 開いた直後の挨拶・入力欄・送信ボタンが英語。
  await expect(drawer).toContainText('Need help? Describe your visit');
  await expect(drawer.getByPlaceholder('e.g. I am here to see Ms. Yamada')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Send' })).toBeVisible();

  // ドロワー全体に日本語が露出しない（クイックリプライの固定導線を含む）。
  const text = await drawer.innerText();
  expect(/[぀-ヿ㐀-䶿一-鿿가-힣]/.test(text), `未翻訳の CJK が残っている: ${text}`).toBe(false);
});
