import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 音声認識（STT）候補確認フローの E2E (issue #5)。
 * 受け入れ条件: 音声認識結果だけで呼び出しが実行されない（候補は確認操作必須）。
 *
 * 音声設定はグローバルのため、sttEnabled を一時的に true にして検証し、
 * finally で必ず false に戻す。既定無効→有効の順で検証するため serial 実行とする
 * （並行テスト汚染回避）。実ブラウザの音声認識は実機前提（#65）。
 */
test.describe.configure({ mode: 'serial' });

test('STT 既定無効: 受付端末に音声検索パネルは出ない', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-search')).toBeVisible();
  await expect(page.getByTestId('stt-panel')).toHaveCount(0);
});

test('STT 有効: 候補はタップで検索欄に反映するのみで、呼び出しは実行されない', async ({ page }) => {
  await loginAsAdmin(page);
  // STT を一時有効化。
  const put = await page.request.put('/api/admin/voice', { data: { sttEnabled: true } });
  expect(put.ok()).toBeTruthy();

  try {
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();

    // 音声検索を実行して候補を表示する。
    await page.getByTestId('stt-listen').click();
    const firstCandidate = page.getByTestId('stt-candidate-0');
    await expect(firstCandidate).toBeVisible();
    const candidateText = (await firstCandidate.textContent())?.trim() ?? '';
    expect(candidateText.length).toBeGreaterThan(0);

    // 候補タップは検索欄に反映するのみ（担当者選択・呼び出しはしない）。
    await firstCandidate.click();
    await expect(page.getByTestId('staff-search')).toHaveValue(candidateText);

    // 確認画面（呼び出し）には遷移していない＝音声認識だけでは呼び出されない。
    await expect(page.getByTestId('confirm-call')).toHaveCount(0);
    await expect(page.getByTestId('staff-search')).toBeVisible();
  } finally {
    // 必ず既定（無効）へ戻す。
    await page.request.put('/api/admin/voice', { data: { sttEnabled: false } });
  }
});
