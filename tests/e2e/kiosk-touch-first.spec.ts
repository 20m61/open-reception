import { test, expect } from './kiosk-fixtures';

/**
 * タッチファースト受付導線の iPad viewport E2E (issue #121 / Epic #119)。
 *
 * 初期画面に主要 CTA を大きなカードで提示し、音声・チャットなしでタッチだけで主要受付
 * パターンへ 1 タップで進めること、状態に応じた逃げ道（戻る/キャンセル等）が出ることを検証する。
 * ボタン集合・操作可否の真実源は #120 の UX 契約（ユニット: src/components/kiosk/quick-actions.test.ts）。
 */

test('初期画面に主要クイックアクションが大きなカードで表示される', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  // 担当者を呼ぶ（後方互換 testid）/ QR で受付 / 部署 / 配送・納品 / その他。
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('start-checkin')).toBeVisible();
  await expect(page.getByTestId('quick-department')).toBeVisible();
  await expect(page.getByTestId('quick-delivery')).toBeVisible();
  await expect(page.getByTestId('quick-other')).toBeVisible();
});

test('担当者を呼ぶ から 1 タップで目的選択へ進む（音声・チャット不要）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
});

test('配送・納品 は目的を先取りして担当/部署選択へ直行する', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('quick-delivery').click();
  // 目的選択をスキップし、担当者・部署選択へ進む。
  await expect(page.getByTestId('target-back')).toBeVisible();
});

test('進行中の画面に常時見える逃げ道バーが出る', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // selectingTarget では 戻る・キャンセル の逃げ道が常設される（内容が長くても常時可視）。
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
  await expect(page.getByTestId('escape-cancel')).toBeVisible();
  await expect(page.getByTestId('escape-back')).toBeVisible();
});

test('逃げ道のキャンセルで待機画面へ戻れる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('escape-cancel').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
});
