import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 受付端末のプライバシー・安全性ゲート E2E (issue #125 / Epic #119)。
 *
 * 検証する不変条件:
 *  - 呼び出し前に必ず確認画面を通る（自由操作で結果へ飛ばない）。
 *  - 完了/キャンセル後、端末に来訪者の個人情報（氏名）が残らず、次の受付へ持ち越さない。
 *
 * ページはリロードせず同一セッション内で検証し、「アプリ状態としての非保持」を確認する
 * （リロードで消えるのは当然のため、それでは不十分）。
 */

/** 待機画面から来訪者情報入力の手前（担当者選択直後）まで進める。 */
async function startReceptionToVisitorInfo(page: Page, staffTestId = 'staff-staff-sato') {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId(staffTestId).click();
}

test('呼び出し前に必ず確認画面を通る（確認前に結果へ飛ばない）', async ({ page }) => {
  await page.goto('/kiosk');
  await startReceptionToVisitorInfo(page);
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();

  // 確認画面で入力内容が提示され、まだ呼び出していない。
  await expect(page.getByTestId('confirm-name')).toHaveText('来客 一郎');
  await expect(page.getByTestId('result-connected')).toHaveCount(0);

  // 明示確認（タッチ）で初めて呼び出しに進む。
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
});

test('完了後、次の受付に前回の氏名（個人情報）が残らない', async ({ page }) => {
  await page.goto('/kiosk');
  await startReceptionToVisitorInfo(page);
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();
  await expect(page.getByTestId('completed')).toBeVisible();

  // 自動リセットで待機画面へ復帰する。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });

  // リロードせずに次の受付へ進むと、氏名フィールドは空（前回 PII の持ち越しなし）。
  await startReceptionToVisitorInfo(page);
  await expect(page.getByTestId('visitor-name')).toHaveValue('');
});

test('入力途中で無操作が続くと待機へ戻り、氏名（個人情報）が残らない', async ({ page }) => {
  // 無操作タイムアウトを短縮して検証する（本番既定は 60s）。
  await page.goto('/kiosk?inactivityMs=600');
  await startReceptionToVisitorInfo(page);
  await page.getByTestId('visitor-name').fill('来客 三郎');

  // 以降は操作しない。無操作タイムアウトで待機画面へ自動復帰する。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 5_000 });

  // 再開しても前回の氏名は残らない（PII 破棄）。
  await startReceptionToVisitorInfo(page);
  await expect(page.getByTestId('visitor-name')).toHaveValue('');
});

test('入力途中で「最初に戻る」で待機へ戻り、再開時に氏名が残らない', async ({ page }) => {
  await page.goto('/kiosk');
  await startReceptionToVisitorInfo(page);
  await page.getByTestId('visitor-name').fill('来客 二郎');

  // 逃げ道バーの「最初に戻る」で待機へ戻る (#325 で cancel→reset へ集約)。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();

  // リロードせずに再開しても、前回の氏名は残らない。
  await startReceptionToVisitorInfo(page);
  await expect(page.getByTestId('visitor-name')).toHaveValue('');
});
