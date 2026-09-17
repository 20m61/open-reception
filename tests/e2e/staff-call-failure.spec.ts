import { test, expect, type Page } from '@playwright/test';

/**
 * 担当者画面の失敗表示が**原因を偽らない** (#1123)。
 *
 * ## なぜ e2e でしか縛れないか
 *
 * このリポジトリの component テストは `renderToStaticMarkup` なので、
 * fetch の応答 → `setFailure` → 画面 の相互作用を踏めない。純関数側は
 * `staff-failure.test.ts` が縛っているが、**分岐条件そのもの**（`if (!res.ok)`）を
 * 変異させる族には無力である —— #1021 の admin ログインで実測した型
 * （`if (res.ok || res.status >= 500)` が unit 1525 本を素通りした）。
 *
 * `/staff/calls/[id]` は token が在れば `StaffCallView` を描画し、認可は API 側で行う。
 * したがって**応答を差し替えるだけ**で失敗表示を踏める（実トークンは要らない）。
 */

const STAFF_URL = '/staff/calls/rec-1?token=some-token';

async function openWithStubbedAnswer(
  page: Page,
  status: number,
  body: string,
  contentType = 'application/json',
): Promise<void> {
  await page.route('**/api/staff/calls/*/answer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status, contentType, body });
  });
  await page.goto(STAFF_URL);
}

const statusOf = (page: Page) => page.getByTestId('staff-call-status');

/**
 * 🔴 **本文は JSON にしない。** JSON の 503 だけを stub すると、判定を status から
 * **本文へ戻す**変異が素通りする（レビュー 4 周目の実測）—— 本番で最も起きやすいのは
 * CloudFront が hold page を返す **502 / 504 ＋ HTML** で、そこで `res.json()` が失敗して
 * 「リンクの有効期限切れ」へ落ちる。受付端末側の spec には同じ理由を書いてあったのに、
 * 担当者側にだけ適用していなかった。
 *
 * 🔴 **500 も踏む。** 述語の中の閾値は unit が縛るが、**呼び出し側を `res.status >= 501` へ
 * 書き換える変異**は述語を経由しないので unit からは見えない（レビュー 6 周目の実測で
 * unit 8778 本・e2e 13 本を素通りした）。500 は route 内の throw でそのまま起きる。
 */
for (const httpStatus of [500, 502]) {
  test(`🔴 サーバが ${httpStatus} ＋ HTML を返したら「リンクの有効期限切れ」と言わない`, async ({ page }) => {
    await openWithStubbedAnswer(page, httpStatus, '<html><body>service hold</body></html>', 'text/html');

    const status = statusOf(page);
    await expect(status).toBeVisible();
    // 🔴 本体。原因はサーバ側の設定不備で、リンクは無関係。
    await expect(status).not.toContainText('リンク');
    await expect(status).toContainText('サーバー側の問題');
    // 未認証で開かれる画面なので、どの設定が欠けているかは出さない。
    await expect(status).not.toContainText('SECRET');
  });
}

test('🔴 サーバが 403 を返したらリンク切れの可能性として伝える（下界）', async ({ page }) => {
  // これが無いと、上の主張は**全部を「サーバー側の問題」にする**世界でも満たせる。
  await openWithStubbedAnswer(page, 403, '{"error":"forbidden"}');

  const status = statusOf(page);
  await expect(status).toBeVisible();
  await expect(status).toContainText('リンク');
});

test('🔴 応答が返らないときは原因を断定しない（リンクにも回線にも倒さない）', async ({ page }) => {
  await page.route('**/api/staff/calls/*/answer', (route) => route.abort('failed'));
  await page.goto(STAFF_URL);

  const status = statusOf(page);
  // 🔴 **`unreachable` 固有の語を positive で待つ。** `not.toContainText('リンク')` は
  // 初期表示「通話に接続しています…」でも真になり、`接続できませんでした` は `rejected`
  // 文言でも真なので、**レンダが先に落ち着いたから通っただけ**の形になる（#826 の窓）。
  await expect(status).toContainText('原因は特定できていません');
  await expect(status).not.toContainText('リンク');
  // 🔴 回線も断定しない (#1132)。同じ値へ Vonage の `onError` も入るが、そちらでは
  // answer API が 200 を返し終えており、回線は容疑者ではない。
  await expect(status).not.toContainText('通信状態');
  // 🔴 **文言が指す導線が実在することを、同じ test で縛る（#1132 レビュー 11 周目 MINOR 3）。**
  // 「下の応答からの返答も試せます」は、`StaffResponseActions` が失敗状態でも描画されている
  // ことが前提。将来 `state.kind !== 'error'` でガードされると、**文言だけが存在しない導線を
  // 指す**（担当者が画面下を探して見つからない間、来訪者は「つながった」まま待つ）。
  await expect(page.getByTestId('staff-response-coming')).toBeVisible();
});

/**
 * 🔴 **3 つ目の失敗入口（通話の確立失敗）。**
 *
 * `StaffCallView` が失敗表示へ入る道は 3 本ある —— 応答が非 ok / `fetch` が投げた /
 * **SDK が繋がらない（`onError`）**。3 本目だけオラクルが無く、レビュー 5 周目の実測で
 * `failure: 'unreachable'` → `'rejected'` の 1 語変異が unit 8768 本と e2e 32 本を
 * **素通り**した。
 *
 * この入口は answer API が **200 を返し終えてから**落ちるので、サーバ側は既に
 * `markConnected` 済みである。ここで「リンクの有効期限切れ」と出すと、担当者はリンクを
 * 疑って動かないまま、来訪者は誰も居ない通話を待つ（復帰導線そのものは #1129）。
 *
 * 🔴 **撤回は選べない。** 「原因を渡さない `error`」は判別共用体（AC4 の本体）が許さないので、
 * 機構を減らす代わりに**オラクルを 1 本足す**。
 *
 * 🔴 **今日この `page.route` は一度も呼ばれない。** CSP（`src/lib/security/csp.ts` の
 * `script-src 'self' 'nonce-…'`）が SDK の CDN 取得をレンダラ側で拒否するので、
 * ネットワーク層まで届かない（レビュー 6 周目の実測。ブラウザコンソールに CSP 違反が出る）。
 * つまり**今は CSP のおかげで `onError` を踏んでいる** —— それ自体が欠陥なので #1132 で扱う。
 * ここに `page.route` を残すのは、**#1132 が CSP を開いたときにこの spec の意味が変わらない
 * ようにする**ため（そのとき初めて route が効く）。実 SDK・実資格情報・実機には依存しない。
 */
test('🔴 通話の確立に失敗したときは「リンクの有効期限切れ」と言わない', async ({ page }) => {
  await page.route(/opentok/, (route) => route.abort('failed'));
  await page.route('**/api/staff/calls/*/answer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // 🔴 固定日付を書かない（#833 の time bomb）。
      body: JSON.stringify({
        applicationId: 'TEST-application',
        sessionId: 'TEST-session',
        token: 'TEST-subscriber-token',
        role: 'subscriber',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.goto(STAFF_URL);

  const status = statusOf(page);
  await expect(status).toContainText('原因は特定できていません');
  await expect(status).not.toContainText('リンク');
  await expect(status).not.toContainText('通信状態');
});

/**
 * 🔴 **上界。** ここまでは「失敗したら何か出る」しか言っていないので、**常に失敗文言を
 * 出す**世界でも満たせる。token が無いときの案内（失敗ではない）を併せて見る。
 */
test('token が無いリンクは失敗ではなく案内を出す（上界）', async ({ page }) => {
  await page.goto('/staff/calls/rec-1');
  await expect(page.getByText('無効なリンクです')).toBeVisible();
  await expect(statusOf(page)).toHaveCount(0);
});

/**
 * 🔴 **応答アクション側も同じ面を持つ。** `StaffResponseActions` は別の `submitState` を
 * 持ち、独立に「リンクの有効期限切れ」と言う。純関数を共有していても、**配線は別**なので
 * 別に縛る（#826 の「配線を変異させていない」の型）。
 */
async function submitActionWithStubbedRespond(
  page: Page,
  status: number,
  body = '{"error":"x"}',
  contentType = 'application/json',
): Promise<void> {
  await page.route('**/api/staff/calls/*/respond', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status, contentType, body });
  });
  await page.goto(STAFF_URL);
  // `coming`（今行きます）は確認を要さない種別なので 1 タップで送信される。
  await page.getByTestId('staff-response-coming').click();
}

const responseErrorOf = (page: Page) => page.getByTestId('staff-response-error');

/** 🔴 応答送信の配線も**別**なので、500 / 502 の両方を独立に踏む（上と同じ理由）。 */
for (const httpStatus of [500, 502]) {
  test(`🔴 応答送信が ${httpStatus} ＋ HTML のとき「リンクの有効期限切れ」と言わない`, async ({ page }) => {
    await submitActionWithStubbedRespond(
      page,
      httpStatus,
      '<html><body>service hold</body></html>',
      'text/html',
    );

    const error = responseErrorOf(page);
    await expect(error).toBeVisible();
    await expect(error).not.toContainText('リンク');
    await expect(error).toContainText('サーバー側の問題');
  });
}

test('🔴 応答送信が 403 のときはリンク切れの可能性として伝える（下界）', async ({ page }) => {
  await submitActionWithStubbedRespond(page, 403);

  const error = responseErrorOf(page);
  await expect(error).toBeVisible();
  await expect(error).toContainText('リンク');
});

/**
 * 🔴 **応答送信の通信失敗も踏む。** 変異検証で「送信の catch を `'rejected'` にする」が
 * **生存した**（レビュー後の実測）—— 503/403 だけを見ていて、`unreachable` 経路に
 * オラクルが無かった。届いたか分からない状況で「リンク切れ」と言わないことを縛る。
 */
test('🔴 応答送信が届かないときは通信の問題として伝える', async ({ page }) => {
  await page.route('**/api/staff/calls/*/respond', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.abort('failed');
  });
  await page.goto(STAFF_URL);
  await page.getByTestId('staff-response-coming').click();

  const error = responseErrorOf(page);
  await expect(error).toContainText('通信状態を確かめて');
  await expect(error).not.toContainText('リンク');
});
