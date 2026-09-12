import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 音声認識（STT）候補確認フローの E2E (issue #5 / #1057)。
 *
 * No Typing 後の契約:
 * - STT transcript だけでは担当者を確定しない
 * - transcript は実在する担当者候補ボタンへ解決する
 * - 来訪者が候補ボタンを明示タップした時だけ SELECT_TARGET 相当へ進む
 * - visitor-facing text search / software keyboard は出さない
 *
 * 音声設定はグローバルのため、sttEnabled を一時的に true にして検証し、
 * finally で必ず false に戻す。既定無効→有効の順で検証するため serial 実行とする。
 * 実ブラウザの音声認識は実機前提（#65）。
 */
test.describe.configure({ mode: 'serial' });

test('STT 既定無効: 文字検索を出さず部署群のタッチ経路を残す', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('staff-search')).toHaveCount(0);
  await expect(page.getByTestId('stt-panel')).toHaveCount(0);
  await expect(page.getByTestId('staff-groups')).toBeVisible();
});

test('STT 有効: transcript だけでは進まず、候補の明示タップで担当者を確定する', async ({ page }) => {
  await loginAsAdmin(page);
  const put = await page.request.put('/api/admin/voice', { data: { sttEnabled: true } });
  expect(put.ok()).toBeTruthy();

  try {
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();

    await expect(page.getByTestId('staff-search')).toHaveCount(0);
    await page.getByTestId('stt-listen').click();

    const firstCandidate = page.getByTestId('stt-candidate-0');
    await expect(firstCandidate).toBeVisible();
    expect(((await firstCandidate.textContent()) ?? '').trim().length).toBeGreaterThan(0);

    // STT が候補を返しただけでは担当者選択は完了しない。
    await expect(page.getByTestId('visitor-name')).toHaveCount(0);
    await expect(page.getByTestId('confirm-call')).toHaveCount(0);

    // 候補カードのタップが明示確認。ここで初めて次ターンへ進む。
    await firstCandidate.click();
    await expect(page.getByTestId('visitor-name')).toBeVisible();
    await expect(page.getByTestId('confirm-call')).toHaveCount(0);
  } finally {
    await page.request.put('/api/admin/voice', { data: { sttEnabled: false } });
  }
});
