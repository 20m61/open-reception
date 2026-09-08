import { test, expect, revealStaff, type Page } from './kiosk-fixtures';

/**
 * **形は正しい JSON だが、その画面の型ではない 200** を来訪者導線へ注入する (#1004 増分 2)。
 *
 * ## なぜ e2e が要るか
 *
 * 述語そのものは `src/domain/reception/parse.test.ts` /
 * `src/components/kiosk/checkout/parse.test.ts` が固定している。**繋がっていないのはその間**
 * である ―― 増分 1（PR #1011）では「純関数に 5 種当てて 5/5 kill」と報告したのに
 * **配線を変異させておらず**、配線を戻す変異が unit・e2e とも全生存していた（独立レビューの
 * 実測）。ここは配線を縛るためにある。
 *
 * ## なぜ 500 や接続断では踏めないか
 *
 * この族は `res.ok` が真で `fetch` も throw しない。既存の失敗注入（500 / abort）は
 * どちらも別の枝を通るので、**この経路には一度も入らない**。
 *
 * 🔴 **`page.on('pageerror')` を「画面が落ちていない」のオラクルにしない。** root に
 * `global-error.tsx` があるので描画例外はエラー境界に捕まり、**発火しない**（増分 1 で実測）。
 * 実害は「来訪者に『受付を続けられませんでした』が出る」ことなので、その見出しが
 * 出ていないことを直接見る。
 */

/** 形は JSON だが、その画面の型ではない 200。 */
const WRONG_SHAPE = '{"ok":true}';

async function respondWrongShape(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: WRONG_SHAPE }),
  );
}

/** 来訪者向けの致命画面（root の `global-error.tsx`）が出ていないこと。 */
async function expectNotCrashed(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
}

test.describe('来訪者導線: 形の違う 200 で受付・退館を止めない (#1004)', () => {
  /**
   * 🔴 **退館一覧が落ちると、退館画面ごと使えなくなる。**
   *
   * `stays` が欠けた 200 で `setPresent(undefined)` が走り、次のレンダーの `present.length`
   * が TypeError を投げる。`/kiosk/checkout` に error boundary は無いので root まで上がる。
   */
  test('退館: 一覧の形が違っても画面が落ちず、QR/コードで退館できる', async ({ page }) => {
    await respondWrongShape(page, '**/api/kiosk/checkout');
    await page.goto('/kiosk/checkout');

    await expectNotCrashed(page);

    /*
      **下界。** 「落ちない」だけだと、画面全体を出さない実装でも通る。一覧取得の失敗は
      致命的でない（QR/コードで退館できる）というのが元の設計なので、**入力手段が
      残っていること**まで主張する。
    */
    await expect(page.getByTestId('checkout-code')).toBeVisible();
  });

  /**
   * 🔴 **確認画面は「退館する」を押す直前である。**
   *
   * `summary` が欠けた 200 を通すと `pending.summary.checkedInAt` が throw する。
   * 一覧と違ってここは**退館そのものの導線**なので、落ちると来訪者は退館できない。
   */
  test('退館: 自己特定の応答の形が違っても落ちず、理由が出る', async ({ page }) => {
    await respondWrongShape(page, '**/api/kiosk/checkout/resolve');
    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-code')).toBeVisible();

    // コード経路は「退館コード」と「呼び出し先」の両方が要る（片方だけでは送信できない）。
    await page.getByTestId('checkout-code').fill('123456');
    await page.getByTestId('checkout-target-label').fill('総務部');
    await page.getByTestId('checkout-resolve-submit').click();

    await expectNotCrashed(page);
    // 黙って入力画面に留まらせない（何が起きたか分からないまま押し続けることになる）。
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    // 確認画面へは進めない（進むと `summary` を読んで落ちる）。
    await expect(page.getByTestId('checkout-confirm')).toHaveCount(0);
  });

  /**
   * 🔴 **受付作成の `id` が欠けると、`undefined` が URL へ入る。**
   *
   * 直したかったのは `fetch('/api/kiosk/receptions/undefined/call')` である。この 1 本の
   * 主張が**本題**で、失敗画面が出ることだけを見ていると、`undefined` を URL へ入れたまま
   * サーバに弾かれて失敗画面が出る実装（＝直す前）でも通ってしまう。
   *
   * なお**サーバ側に残る孤児は防げない**（作成の POST は 200 を返しているので受付は存在し、
   * 端末はその ID を知らないので取り消せない）。ここで縛るのは「これ以上悪化させない」ことだけ。
   */
  test('受付: 作成応答の id が読めなければ、undefined を URL に入れない', async ({ page }) => {
    const called: string[] = [];
    // **観測を先に置く。** route より前に付けないと、最初の要求を取りこぼす。
    page.on('request', (req) => {
      if (req.url().includes('/api/kiosk/receptions')) called.push(`${req.method()} ${req.url()}`);
    });
    // 作成（POST /api/kiosk/receptions）だけを差し替える。`/call` などの子パスは通す。
    await page.route('**/api/kiosk/receptions', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: WRONG_SHAPE })
        : route.continue(),
    );

    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 一郎');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();

    // 呼び出しは成立しないので失敗画面へ倒れる（黙って calling に留まらせない）。
    await expect(page.getByTestId('result-failed')).toBeVisible();
    await expectNotCrashed(page);

    /*
      🔴 **これが本題。** `undefined` / 空文字が URL に入っていないこと。
      `id` を検査しない実装ではここに `/api/kiosk/receptions/undefined/call` が現れる。
    */
    expect(called.filter((u) => /\/receptions\/(undefined|null)\//.test(u))).toEqual([]);
    expect(called.filter((u) => /\/receptions\/\/+/.test(u))).toEqual([]);

    // 行き止まりにしない（逃げ道バーは常設）。
    await page.getByTestId('escape-reset').click();
    await expect(page.getByTestId('start-reception')).toBeVisible();
  });
});
