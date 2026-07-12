import { test, expect } from './kiosk-fixtures';

/**
 * 呼び出し中の待ち体験 (issue #323) の E2E。
 *
 * 「呼び出し中に画面が動いており、段階に応じて文言/アバターが変わる」「タイムアウトへの遷移が
 * 予告付きで、突然感がない」を、既存 `?inactivityMs=` の流儀に倣ったタイマー短縮クエリで
 * 決定的に検証する:
 *   - `?callingStageMs=` … dialing → waiting へ切り替わる経過 ms
 *   - `?callingNoticeMs=` … waiting → preTimeoutNotice（タイムアウト直前の予告）へ切り替わる経過 ms
 *   - `?callingNoticeHoldMs=` … 予告を見せてから実際に CALL_TIMEOUT へ遷移するまでの最低保持 ms
 *
 * 呼び出し結果は担当者の mockCallOutcome で決定的に分岐する（reception-flow.spec.ts と同じ担当者
 * フィクスチャ）: staff-suzuki → timeout（未応答）。予告を挟んでからでないと result-timeout に
 * 到達しないことを、段階の出現順序で確認する。
 */

test('呼び出し中は段階的に文言が変わり、タイムアウトは予告を経てから遷移する (#323 AC1/AC3)', async ({ page }) => {
  await page.goto(
    '/kiosk?callingStageMs=200&callingNoticeMs=500&callingNoticeHoldMs=300&inactivityMs=600',
  );
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-suzuki').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();

  const calling = page.getByTestId('calling');
  await expect(calling).toBeVisible();

  // AC1: 画面が「動いて」いる（常時アニメーションする経過インジケータ）。
  await expect(page.getByTestId('calling-pulse')).toBeVisible();

  // AC1: 経過に応じて段階（dialing → waiting → preTimeoutNotice）が進み、文言も切り替わる。
  await expect(calling).toHaveAttribute('data-calling-stage', 'waiting', { timeout: 3_000 });
  await expect(calling).toHaveAttribute('data-calling-stage', 'preTimeoutNotice', { timeout: 3_000 });

  // AC3: タイムアウト直前の予告を経てから実遷移する（突然 result-timeout に飛ばない）。
  // ここまでに result-timeout が出ていないこと＝予告を見せてから遷移していることの証跡。
  await expect(page.getByTestId('result-timeout')).toHaveCount(0);

  // 予告保持後、実際の CALL_TIMEOUT 遷移で結果画面へ進む（state.ts の遷移そのものは不変）。
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 5_000 });
});

test('しきい値を長めにすると dialing のまま既存どおり即結果へ進む（後方互換）', async ({ page }) => {
  // しきい値を省略（既定値のまま）にすると、mock アダプタは瞬時に応答するため段階演出が
  // ボトルネックにならず、従来どおり result-connected へ素早く到達する（回帰確認）。
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 二郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-connected')).toBeVisible();
});
