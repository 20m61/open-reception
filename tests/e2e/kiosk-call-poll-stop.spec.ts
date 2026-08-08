import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 呼び出し中を抜けたら結果ポーリングが止まることの E2E (issue #652 / #647)。
 *
 * #647 の PSTN 結果ポーリングは `pstnCallId` だけを見ており、それを null に戻すのは
 * `data.state === 'calling'` の effect の先頭だけだった。つまり**来訪者が呼び出し中から
 * 抜けても最大 5 分（CALL_STATUS_POLL_MAX_MS）ポーリングが回り続ける**。
 *
 * 状態機械は終端状態で `CALL_*` を不正遷移として無視するので**画面は壊れず**、
 * 既存のテストもゲートも緑のまま通る種類の欠陥。よって「止まること」を時間軸で直接測る。
 */

/** `/call` が calling のまま返り、`/status` も calling を返し続ける（結果が確定しない）状態。 */
async function stubUnresolvedCalling(page: Page, count: { status: number }): Promise<void> {
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  await page.route('**/api/kiosk/receptions/*/status', (route) => {
    count.status += 1;
    return route.fulfill({ json: { state: 'calling' } });
  });
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

test('呼び出し中から待機へ戻ったら /status のポーリングが止まる', async ({ page }) => {
  const count = { status: 0 };
  await stubUnresolvedCalling(page, count);

  await page.goto('/kiosk');
  await driveToCalling(page);

  // まずポーリングが実際に走っていることを確かめる。走っていなければこのテスト自体が無意味。
  await expect.poll(() => count.status, { timeout: 15_000 }).toBeGreaterThan(1);

  // 逃げ道バーで待機へ戻る（RESET）。来訪者はこの時点で端末の前から居なくなっている。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();

  // 遷移直後に飛んだ 1 本を数え込まないよう、少し落ち着かせてから基準値を採る。
  await page.waitForTimeout(1_000);
  const afterReset = count.status;

  // ポーリング間隔は 3 秒。2 周期以上待って 1 本も増えないこと。
  await page.waitForTimeout(7_000);
  expect(count.status).toBe(afterReset);
});
