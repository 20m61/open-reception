import { test, expect } from './kiosk-fixtures';

/**
 * 受付中に閉店した来訪者に、果たせない約束をしない (#736 Gate A)。
 *
 * ## なぜ e2e が要るか
 *
 * サーバが営業時間外に 409 `out_of_hours` を返すことは
 * `src/app/api/kiosk/receptions/[id]/call/route.test.ts:160` が固定している。
 * 文言と CTA の判断は `src/domain/reception/call-failure.test.ts` が固定している。
 *
 * 🔴 **繋がっていないのはその間だった。** `KioskFlow` は `unrouted` だけを名指しで拾い、
 * 他の理由は状態分岐を素通りして最後の else で `server` に潰していた。この配線を
 * 元に戻す変異を当てても **6143 テスト全部が green のまま**だった（実測）。
 * 「部品は全部 green なのに繋がっていない」を落とすのがこのファイルの役目。
 *
 * ## 到達経路
 *
 * `resolveKioskMode` は進行中の来訪者を中断しないので `receptionState === 'idle'` の
 * ときしか `out_of_hours` を返さない。よって**営業中に受付を始めて、確認画面で手間取って
 * いる間に閉店した来訪者**は必ずこの枝を通る。待機画面を閉店にしても再現できないため、
 * 発信の応答だけを差し替えて同じ状況を作る。
 */
test('営業時間外に閉店をまたいだ呼び出しで、果たせない約束をしない', async ({ page }) => {
  await page.route('**/api/kiosk/receptions/*/call', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'out_of_hours',
        reason: 'out_of_hours',
        reopenAt: '2026-08-21T00:00:00.000Z',
      }),
    });
  });

  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();

  const result = page.getByTestId('result-failed');
  await expect(result).toBeVisible();

  // 🔴 「呼び出しに失敗しました」と読ませない ── 呼び出しは一度も行われていない。
  await expect(result).toContainText('受付時間外');
  await expect(result).not.toContainText('呼び出しに失敗しました');

  // 🔴 「代表窓口にお繋ぎします」は営業時間外に果たせない約束。主 CTA にしない。
  await expect(page.getByTestId('use-fallback')).toHaveCount(0);

  // 行き止まりにはしない（逃げ道バーは常設）。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});
