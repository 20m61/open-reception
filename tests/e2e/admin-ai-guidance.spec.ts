import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * AI 案内設定の管理 E2E (issue #104)。
 * 既定は無効。有効化と許可トピックの保存・正規化（重複除去）・再読込での永続化を検証する。
 */
test('AI案内を有効化し許可トピックを保存できる（正規化・永続化）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/ai-guidance');

  const enabled = page.getByTestId('ai-guidance-enabled');
  const topics = page.getByTestId('ai-guidance-topics');

  // 有効化して許可トピックを入力（重複・空白を含む）。
  await enabled.check();
  await topics.fill('FAQ, 施設案内, FAQ ,');
  await page.getByTestId('ai-guidance-save').click();
  await expect(page.getByTestId('ai-guidance-saved')).toBeVisible();

  // サーバ側で正規化（重複除去・trim）された結果が反映される。
  await expect(topics).toHaveValue('FAQ\n施設案内');

  // 再読込しても永続している。
  await page.reload();
  await expect(page.getByTestId('ai-guidance-enabled')).toBeChecked();
  await expect(page.getByTestId('ai-guidance-topics')).toHaveValue('FAQ\n施設案内');
});
