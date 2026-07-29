import { test, expect, type Page } from './kiosk-fixtures';

/**
 * QR 受付の常設逃げ道バー (issue #361 AC「QR 受付が独立した別 UI に見えず、同じ受付体験と
 * して進行する」)。
 *
 * 受付側は #325 で後退系コントロールを常設バーへ一本化し、#39 で**画面分岐の外**へ出した
 * （分岐の中に置くと新しい枝で入れ忘れ、実際にカスタム受付フローが行き止まりになった）。
 * **QR 受付にはその構造が無く**、各画面が `CANCEL`/`exit` ボタンを手書きしていた（`checkin-exit`
 * / `method-cancel` / `camera-cancel` / `scan-cancel` / `checkin-reset`）。契約の
 * `checkinEscapeHatchesFor` は消費者ゼロで、後退の位置と語彙が受付と QR で違っていた。
 *
 * ここは**バーが実際に全ターンへ常設されているか**の消費者。`quick-actions.test.ts` は
 * 表示メタを固定するが、シェルが分岐の外で描いているかは実 DOM でしか分からない。
 */

/** QR 受付の逃げ道バー。受付側（`kiosk-escape-bar`）とは領域 identity を分ける。 */
function bar(page: Page) {
  return page.getByTestId('checkin-escape-bar');
}

/** 画面ごとに手書きされていた後退ボタン。統合後はどのターンにも現れてはいけない。 */
const REMOVED_PER_SCREEN_BACKS = [
  'checkin-exit',
  'method-cancel',
  'camera-cancel',
  'scan-cancel',
  'checkin-reset',
  'checkin-error-reset',
] as const;

async function expectNoPerScreenBacks(page: Page) {
  for (const testId of REMOVED_PER_SCREEN_BACKS) {
    await expect(page.getByTestId(testId), `${testId} は常設バーへ統合済み`).toHaveCount(0);
  }
}

test('QR 受付の入口から逃げ道バーが常設される（受付の idle と違い戻る先がある）', async ({
  page,
}) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();

  await expect(bar(page)).toBeVisible();
  await expect(bar(page).getByTestId('escape-reset')).toBeVisible();
  await expectNoPerScreenBacks(page);
});

test('バーはヘルプ領域として登録されている（常設要素の 3 領域・#422 inc5-c）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();

  await expect(bar(page)).toHaveAttribute('data-persistent-region', 'help');
});

test('読み取りまで進んでも全ターンでバーが消えない（分岐の外に在る）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await expect(bar(page)).toBeVisible();

  await page.getByTestId('checkin-start').click();
  await expect(bar(page)).toBeVisible();
  await expectNoPerScreenBacks(page);

  await page.getByTestId('method-qr').click();
  await expect(bar(page)).toBeVisible();

  await page.getByTestId('camera-grant').click();
  await expect(page.getByTestId('checkin-scanning')).toBeVisible();
  await expect(bar(page)).toBeVisible();
  await expectNoPerScreenBacks(page);
});

test('エラーへ落ちてもバーが在り、通常受付への切替はコンテンツ側に残る', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();
  await page.getByTestId('camera-deny').click();

  await expect(page.getByTestId('checkin-error-cameraError')).toBeVisible();
  await expect(bar(page)).toBeVisible();
  // 「通常受付へ」は後退ではなく別レールへの前進なので、バーではなくコンテンツの主 CTA。
  await expect(page.getByTestId('checkin-error-manual')).toBeVisible();
  await expectNoPerScreenBacks(page);
});

test('最初に戻るを押すと kiosk 待機画面へ帰る（QR に入って戻れない行き止まりを作らない）', async ({
  page,
}) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();
  await expect(page.getByTestId('camera-grant')).toBeVisible();

  await bar(page).getByTestId('escape-reset').click();

  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('checkin-shell')).toHaveCount(0);
});

test('English を選ぶとバーの文言も英語になる（受付と同じ語彙・同じ訳）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-checkin').click();

  await expect(bar(page).getByTestId('escape-reset')).toHaveText('Start over');
  await expect(bar(page)).toHaveAttribute('lang', 'en');
});
