import { test, expect } from './kiosk-fixtures';

/**
 * ワンタップ満足度フィードバック (issue #320) の E2E。
 *
 * 完了/未応答/失敗の終端画面で、評価が「1 タップで確定」し「直後に既存の自動復帰がそのまま動く」
 * こと（AC1/AC2）を検証する。呼び出し結果は reception-flow.spec.ts と同じ決定的な mock 分岐
 * （staff-sato=connected, staff-suzuki=timeout, staff-takahashi=failed）を使う。
 */

async function advanceToConfirm(page: import('@playwright/test').Page, staffTestId: string, query = '') {
  await page.goto(`/kiosk${query}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId(staffTestId).click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
}

test('完了画面: 1 タップで評価でき、直後に既存の自動復帰（待機画面へ）が動く', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato');
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();

  await expect(page.getByTestId('completed')).toBeVisible();
  await expect(page.getByTestId('satisfaction-feedback')).toBeVisible();

  // 1 タップで評価が確定し、感謝メッセージ＋任意の理由チップに切り替わる。
  await page.getByTestId('satisfaction-happy').click();
  await expect(page.getByTestId('satisfaction-feedback-thanks')).toBeVisible();

  // 評価しても既存の自動復帰タイマー（AUTO_RESET_MS=6000）はそのまま動き、待機画面へ戻る。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });
});

test('評価せず放置しても、既存の自動復帰は変わらず動く（AC: 体験が変わらない）', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato');
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();

  await expect(page.getByTestId('completed')).toBeVisible();
  await expect(page.getByTestId('satisfaction-feedback')).toBeVisible();

  // 何もタップしない。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });
});

test('未応答画面でも評価でき、理由チップを追加で選べる', async ({ page }) => {
  await advanceToConfirm(
    page,
    'staff-staff-suzuki',
    '?callingStageMs=100&callingNoticeMs=200&callingNoticeHoldMs=100',
  );
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-timeout')).toBeVisible();
  await expect(page.getByTestId('satisfaction-feedback')).toBeVisible();

  await page.getByTestId('satisfaction-unhappy').click();
  await expect(page.getByTestId('satisfaction-feedback-thanks')).toBeVisible();
  await page.getByTestId('satisfaction-reason-waitTooLong').click();
  await expect(page.getByTestId('satisfaction-reason-waitTooLong')).toHaveAttribute('aria-pressed', 'true');

  // 通常どおり代替導線・逃げ道バーは引き続き機能する（評価 UI が既存導線を妨げない）。
  await page.getByTestId('use-fallback').click();
  await expect(page.getByTestId('fallback')).toBeVisible();
});

test('失敗画面でも評価できる', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-takahashi');
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-failed')).toBeVisible();
  await expect(page.getByTestId('satisfaction-feedback')).toBeVisible();

  await page.getByTestId('satisfaction-neutral').click();
  await expect(page.getByTestId('satisfaction-feedback-thanks')).toBeVisible();
});

test('自由記述欄が無い（PII 混入経路が構造的に無い）', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato');
  await page.getByTestId('confirm-call').click();
  await page.getByTestId('complete').click();
  await expect(page.getByTestId('satisfaction-feedback')).toBeVisible();

  const textInputs = page.locator('[data-testid="satisfaction-feedback"] input[type="text"], [data-testid="satisfaction-feedback"] textarea');
  await expect(textInputs).toHaveCount(0);
});
