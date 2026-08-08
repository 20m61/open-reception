import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 呼び出し中（calling）の担当者応答反映 E2E (issue #649 / #99)。
 *
 * #99 は「呼び出し中・応答後に担当者の応答を画面へ出す」ためのものだが、受付 ID が結果と
 * 一緒にしか立たなかったため **calling の間は 1 度もポーリングが走っていなかった**。
 * ここで固定するのは「呼び出し中に応答が届いたら、その場で画面に出る」こと。
 *
 * PSTN 発信中（`/call` が `calling` のまま返る）を模す。実発信はしない — provider へは
 * 一切触れず、`/call` と `/status` の応答だけを差し替える。
 */

/** `/call` が calling のまま返り、`/status` が担当者応答を返す状態を作る。 */
async function stubCallingWithStaffResponse(
  page: Page,
  staffResponse: Record<string, unknown> | null,
): Promise<void> {
  // 発信は完了せず「呼び出し中」のまま（PSTN 相当）。ビデオセッションは無い。
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  // 端末が取りに来る状態。calling のままなので結果は確定せず、担当者応答だけが載る。
  await page.route('**/api/kiosk/receptions/*/status', (route) =>
    route.fulfill({
      json: staffResponse === null ? { state: 'calling' } : { state: 'calling', staffResponse },
    }),
  );
}

/** 待機画面から確認画面の「呼ぶ」まで進める。 */
async function driveToCalling(page: Page): Promise<void> {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 四郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
}

test('呼び出し中に届いた担当者応答が、その場で画面に出る', async ({ page }) => {
  await stubCallingWithStaffResponse(page, {
    action: 'coming',
    kioskStatus: 'acknowledged',
    visitorMessage: 'まもなく参ります',
    severity: 'success',
    offersFallback: false,
    respondedAt: '2026-08-08T00:00:00.000Z',
  });

  await page.goto('/kiosk');
  await driveToCalling(page);

  // 呼び出し中のまま応答バナーが出ること（結果確定を待たない）。
  await expect(page.getByTestId('staff-response-banner')).toBeVisible();
  await expect(page.getByTestId('staff-response-message')).toHaveText('まもなく参ります');
  // 状態は calling のまま（応答は結果ではない）。
  await expect(page.getByTestId('staff-response-banner')).toHaveAttribute(
    'data-status',
    'acknowledged',
  );
});

test('呼び出し中の拒否応答から代替導線へ進める', async ({ page }) => {
  // offersFallback の応答。calling からは USE_FALLBACK が不正遷移なので、端末はまず
  // failed へ落としてから既存の代替導線へ繋ぐ（KioskFlow.handleStaffResponseFallback）。
  await stubCallingWithStaffResponse(page, {
    action: 'decline',
    kioskStatus: 'declined',
    visitorMessage: '本日は対応できません',
    severity: 'danger',
    offersFallback: true,
    respondedAt: '2026-08-08T00:00:00.000Z',
  });

  await page.goto('/kiosk');
  await driveToCalling(page);

  await page.getByTestId('staff-response-fallback').click();
  // 呼び出し中画面から抜け、結果（代替導線を出せる）画面に居ること。
  await expect(page.getByTestId('staff-response-fallback')).toHaveCount(0);
  await expect(page.getByTestId('result-failed')).toBeVisible();
});
