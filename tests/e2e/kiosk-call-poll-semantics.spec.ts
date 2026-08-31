import { test, expect, type Page, revealStaff } from './kiosk-fixtures';

/**
 * 実 PSTN 発信の結果確定ポーリングの**意味論**を固定する E2E (issue #652 AC3 / #647)。
 *
 * `decidePollAction` の純ロジックは `src/domain/reception/call-poll.test.ts` が固定しているが、
 * **effect レベルの意味論は未固定**だった。#652 の 1 本化リファクタは本番稼働中の発信結果確定に
 * 触るため、先にここで安全網を張る。
 *
 * 固定する性質:
 *  1. **権威はサーバ**。端末は経過時間で結果を作らず、サーバが返した state で確定する
 *  2. 単発の取得失敗ではポーリングを諦めない（電話は鳴り続けている）
 *
 * 1 の 2 本は `cache: 'no-store'` の担保も兼ねる。同一 URL の GET が回を追って**違う本文**を
 * 返し、それを端末が観測できなければ通らないため（キャッシュに当たると calling のまま止まる）。
 */

/** `/status` の応答列を作る。calling を `callingTurns` 回返したあと `final` を返し続ける。 */
async function stubCallThenStatus(
  page: Page,
  callingTurns: number,
  final: string,
): Promise<void> {
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  let turn = 0;
  await page.route('**/api/kiosk/receptions/*/status', (route) => {
    turn += 1;
    const state = turn <= callingTurns ? 'calling' : final;
    return route.fulfill({ json: { state } });
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

test('サーバが connected を返したらその結果で確定する（権威はサーバ）', async ({ page }) => {
  // 1 回目は calling、2 回目以降 connected。端末は経過時間ではなくこの応答で確定する。
  await stubCallThenStatus(page, 1, 'connected');

  await page.goto('/kiosk');
  await driveToCalling(page);

  await expect(page.getByTestId('result-connected')).toBeVisible({ timeout: 20_000 });
});

test('サーバが timeout を返したら未応答として確定する', async ({ page }) => {
  await stubCallThenStatus(page, 1, 'timeout');

  // 🔴 **段階しきい値を縮めるのは「速さ」を測っているからではない** (#832)。
  //
  // PSTN の `CALL_TIMEOUT` は予告保持ゲートを通るようになった（#323 AC3 を実経路でも満たす
  // ため）。既定しきい値では予告 25s ＋ 保持 5s = **30 秒**かかるので、この spec は素で赤くなる。
  //
  // ここが主張しているのは「**どの結果に確定するか**（権威はサーバ）」であって到達時間ではない。
  // よって主張は 1 文字も緩めず、ゲートが律速にならないところまでしきい値だけを縮める
  // （`?inactivityMs=` と同じ、このリポジトリ既定の短縮クエリの流儀）。
  // 予告そのものが飛ばないことは `kiosk-calling-stage.spec.ts` の PSTN テストが縛る。
  await page.goto('/kiosk?callingStageMs=200&callingNoticeMs=500&callingNoticeHoldMs=300');
  await driveToCalling(page);

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
});

test('/status の取得に失敗してもポーリングを諦めない', async ({ page }) => {
  // 電話は鳴り続けているので、単発の失敗で代替導線へ倒してはいけない。
  //
  // 🔴 **回数ではなく時間窓で落とす。** `/status` は現状 2 経路が叩いており
  // （`useStaffResponse` と結果ポーリング・issue #652 の 1 本化対象）、**リクエストからは
  // 区別できない**。「最初の N 回を落とす」と書くと、落ちた分が結果ポーリングではなく
  // 担当者応答ポーリング（失敗を握り潰す）に消費され、**検査したい経路を素通りする**。
  // 実際この形で書いたところ、「初回失敗で即諦める」変異を 1 つも kill できなかった。
  //
  // 結果ポーリングの初回は発信の 3 秒後なので、開始から 5 秒間すべて落とせば確実に当たる。
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  let failUntil = 0;
  await page.route('**/api/kiosk/receptions/*/status', (route) => {
    if (failUntil === 0) failUntil = Date.now() + 5_000;
    if (Date.now() < failUntil) return route.abort();
    return route.fulfill({ json: { state: 'connected' } });
  });

  await page.goto('/kiosk');
  await driveToCalling(page);

  await expect(page.getByTestId('result-connected')).toBeVisible({ timeout: 30_000 });
});
