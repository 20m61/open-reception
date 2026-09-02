import { test, expect, type Page, revealStaff } from './kiosk-fixtures';

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
  await revealStaff(page, 'staff-staff-sato');
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

/**
 * 呼び出し中に来訪者が自分で抜けたら、**サーバの受付も止める** (#743)。
 *
 * 上のテストが確かめているのは「端末がポーリングをやめる」ことだけ。それだけだと
 * サーバの受付は `calling` のまま残り、`decideRoutingStop` は「進んでよい」と答え続けて
 * **取次は hop 上限まで進み、社内の電話が鳴り続ける**。しかもポーリングが止まるので
 * `/give-up`（#743 AC3）も呼ばれない ── 自分から抜けるほうが、放っておくより取次が
 * 長く走ることになる。
 *
 * 🔴 端末側の実装（`leaveWithServer`）を**振る舞いで**縛る。ソースを走査する形だと、
 * 3 つ目の出口が足されたときに黙って漏れる。
 */
test('🔴 呼び出し中に逃げ道バーで抜けたら受付キャンセルをサーバへ送る', async ({ page }) => {
  const count = { status: 0 };
  await stubUnresolvedCalling(page, count);

  const cancels: string[] = [];
  await page.route('**/api/kiosk/receptions/*/cancel', (route) => {
    cancels.push(route.request().url());
    return route.fulfill({ json: { id: 'rec-1', state: 'cancelled' } });
  });

  await page.goto('/kiosk');
  await driveToCalling(page);
  await expect.poll(() => count.status, { timeout: 15_000 }).toBeGreaterThan(0);

  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();

  await expect.poll(() => cancels.length, { timeout: 5_000 }).toBe(1);
});

/**
 * 🔴 **呼び出し中でなければ送らない。** 取次が走っていない局面で撃つと、
 * 既に終端した受付（担当者が応答した直後など）を蒸し返す余地を作る。
 */
test('🔴 呼び出し前に逃げ道バーで抜けてもキャンセルは送らない', async ({ page }) => {
  const cancels: string[] = [];
  await page.route('**/api/kiosk/receptions/*/cancel', (route) => {
    cancels.push(route.request().url());
    return route.fulfill({ json: { id: 'rec-1', state: 'cancelled' } });
  });

  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();

  await page.waitForTimeout(1_000);
  expect(cancels).toHaveLength(0);
});
