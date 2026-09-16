import { test, expect, type Page } from '@playwright/test';

/**
 * 受付端末エンロール画面の失敗表示が**原因を偽らない** (#1123)。
 *
 * ## なぜ e2e が要るか
 *
 * 文言表だけを縛るソース検査（`src/app/kiosk/enroll/error-copy.test.ts`）は
 * **「表に行が在る」しか見ていない**。レビュー 2 周目の実測では、`toError` の入口で
 * `unavailable` だけを潰す変異（＝1 周目の修正をピンポイントで撤回する）が
 * **unit 8747 本を全部素通り**した。担当者側で同じ結論に達していたのに、
 * 受付端末側にだけ適用していなかった。
 *
 * 🔴 **「502 ＋ HTML 本文」を必ず含める。** 本番で最も起きやすいのは JSON の 503 ではなく、
 * CloudFront が hold page を返す 502 / 504 である（`web-stack.ts` の `errorResponses`）。
 * `{"error":"unavailable"}` だけを stub すると、本文で判定する実装が素通りする。
 */

const ENROLL_URL = '/kiosk/enroll?token=some-token';

async function openWithStubbedEnroll(
  page: Page,
  status: number,
  body: string,
  contentType = 'application/json',
): Promise<void> {
  await page.route('**/api/kiosk/enroll', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status, contentType, body });
  });
  await page.goto(ENROLL_URL);
}

const errorOf = (page: Page) => page.getByTestId('enroll-error');

test('🔴 サーバが 503（JSON）を返したら「再発行してください」と言わない', async ({ page }) => {
  await openWithStubbedEnroll(page, 503, '{"error":"unavailable"}');

  await expect(errorOf(page)).toContainText('サーバー側の問題');
  await expect(errorOf(page)).not.toContainText('再発行');
  // 🔴 袋小路にしない。5xx には一過性（502/504・コールドスタート）も含まれるので
  // 再試行は妥当。鍵未設定なら再試行も直らないが、そのときの導線は文言が言う
  // 「管理者へ連絡」であり、**「再発行してください」ではない**（再発行も同じ鍵で落ちる）。
  await expect(page.getByTestId('enroll-retry')).toBeVisible();
});

/**
 * 🔴 **本番で起きる「本文が JSON でない 5xx」を踏む。** 本文で判定していると
 * `invalid_token` へ落ちる。踏む status は 2 つ要る:
 *
 * - **500** … route の中で throw（`consumeEnrollment` の DynamoDB 障害等）→ Next の既定 500 ＋ HTML
 * - **502** … Lambda のコールドスタート失敗 / タイムアウトで CloudFront が hold page を返す
 *   （`infra/lib/stacks/web-stack.ts` の `errorResponses`）
 *
 * 🔴 **500 を落とすと、呼び出し側の閾値が誰にも縛られなくなる。** 述語 `isServerSideFailure`
 * の中の閾値は unit（`http-failure.test.ts`）が縛るが、**呼び出し側を `res.status >= 501` へ
 * 書き換える変異**は述語を経由しないので unit からは見えない —— レビュー 6 周目の実測で
 * unit 8778 本・e2e 13 本を素通りした。「e2e は 502/503 を踏めば足りる」という私の分担の
 * 主張が誤りで、**3 周目に実際に欠陥が在った場所（呼び出し側）にちょうど穴が開いていた**。
 */
for (const status of [500, 502]) {
  test(`🔴 ${status} ＋ HTML 本文でも「再発行してください」と言わない`, async ({ page }) => {
    await openWithStubbedEnroll(page, status, '<html><body>service hold</body></html>', 'text/html');

    await expect(errorOf(page)).toContainText('サーバー側の問題');
    await expect(errorOf(page)).not.toContainText('再発行');
    await expect(page.getByTestId('enroll-retry')).toBeVisible();
  });
}

/**
 * 🔴 **下界。** ここまでは「全部サーバー側の問題にする」世界でも満たせる。
 * 端末側エラー（再発行が正しい対処）が従来どおり出ることまで見る。
 */
test('🔴 400 invalid_token は従来どおり「再発行してください」（下界）', async ({ page }) => {
  await openWithStubbedEnroll(page, 400, '{"error":"invalid_token"}');

  await expect(errorOf(page)).toContainText('再発行');
  await expect(errorOf(page)).not.toContainText('サーバー側の問題');
  // 端末側エラーは何度叩いても直らないので、再試行ボタンは出さない。
  await expect(page.getByTestId('enroll-retry')).toHaveCount(0);
});

/**
 * 🔴 **通信失敗にもオラクルを置く（担当者側の 2 本と対）。**
 *
 * 4 周目に担当者側で同型の変異（`catch` を `rejected` にする）を 2 本潰したのに、
 * **受付端末側へ当て直していなかった** —— レビュー 5 周目の実測で、
 * `toError('network')` → `toError('invalid_token')` の 1 語変異が unit 8768 本と
 * e2e 32 本を素通りした。この増分が繰り返している型（片方を丁寧に・もう片方を安く）そのもの。
 *
 * 設置作業中の通信断で「URLが無効か期限切れです／**管理画面で再発行してください**」＋
 * **再試行ボタン無し**へ落ちると、再発行自体は成功するので設置者は袋小路をループする。
 */
test('🔴 通信に失敗したときは「再発行してください」と言わない', async ({ page }) => {
  await page.route('**/api/kiosk/enroll', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.abort('failed');
  });
  await page.goto(ENROLL_URL);

  // 🔴 `network` 固有の語を positive で待つ。`not.toContainText(...)` だけだと
  // 「まだ何も描画されていない」状態でも真になる（#826 の窓）。
  await expect(errorOf(page)).toContainText('ネットワークを確認');
  await expect(errorOf(page)).not.toContainText('再発行');
  await expect(errorOf(page)).not.toContainText('サーバー側の問題');
  await expect(page.getByTestId('enroll-retry')).toBeVisible();
});

test('🔴 token が無いリンクは案内を出す（上界）', async ({ page }) => {
  await page.goto('/kiosk/enroll');
  await expect(errorOf(page)).toContainText('URLが不正です');
});
