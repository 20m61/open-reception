import { test, expect } from '../kiosk-fixtures';

/**
 * 時刻加速による決定的な境界テスト (issue #317)。
 *
 * 無操作リセットや日付跨ぎは実運用では時間・日をまたいで初めて顕在化するが、実時間で
 * 待つと smoke モードの短時間予算に収まらない。既存の `?inactivityMs=` 短縮フラグに加えて
 * Playwright の Clock API（`page.clock`）を組み合わせ、「境界のすぐ内側/外側」を決定的かつ
 * 高速に踏む。`page.clock.runFor()` を使う（`fastForward()` と異なり、途中の
 * setTimeout/setInterval 連鎖 — 無操作カウントダウン警告 → リセット — を実時間同様に
 * 順序どおり発火させるため、本実装の入れ子タイマーと整合する）。
 *
 * このファイルは soak 専用 project（`playwright.soak.config.ts`）でのみ実行され、既定の
 * `npm run test:e2e` / `--pr` の対象からは除外されている。
 */
test.describe('soak: 時刻加速による境界テスト', () => {
  test('セッション更新: 操作するたびに無操作タイマーが延長される', async ({ page }) => {
    await page.clock.install();
    await page.goto('/kiosk?inactivityMs=6000');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await page.getByTestId('staff-staff-sato').click();

    // 閾値(6000ms)未到達まで進める。
    await page.clock.runFor(5000);
    await expect(page.getByTestId('visitor-name')).toBeVisible();

    // ここで操作 → 無操作タイマーが最初から測り直される（延長）はず。
    // 延長は window の pointerdown/keydown で検知される（実装は要素個別ではなく window に
    // リスナーを張っている）。カウントダウン警告バナーがちょうど表示中の可能性があり、
    // click() のヒットターゲット判定に巻き込まれるのを避けるため、window へ直接
    // pointerdown を発火させて操作を模す（fill() は値のセットのみでヒットテストを伴わない）。
    await page.evaluate(() => window.dispatchEvent(new Event('pointerdown')));
    await page.getByTestId('visitor-name').fill('来客 加速太郎');
    // 操作直後を起点に 4000ms しか経過していないので、延長されていれば閾値未到達のまま維持される。
    // 延長されていなければ累計 9000ms > 6000ms でリセットされてしまう。
    await page.clock.runFor(4000);
    await expect(page.getByTestId('visitor-name')).toHaveValue('来客 加速太郎');

    // 最後は無操作のまま閾値を超えさせ、待機画面へリセットされることを確認する。
    await page.clock.runFor(7000);
    await expect(page.getByTestId('start-reception')).toBeVisible();
  });

  test('無操作タイムアウト境界: 閾値直前は維持され、閾値超過でリセットされる', async ({ page }) => {
    await page.clock.install();
    await page.goto('/kiosk?inactivityMs=5000');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();

    // 閾値の少し手前まで進めても選択画面のまま（境界のすぐ内側）。
    await page.clock.runFor(4500);
    await expect(page.getByTestId('staff-staff-sato')).toBeVisible();

    // 閾値を超えると待機へリセットされる（境界のすぐ外側）。
    await page.clock.runFor(1000);
    await expect(page.getByTestId('start-reception')).toBeVisible();
  });

  test('connected（来訪待ち）の無操作境界を時刻加速で厳密に確認する (#324)', async ({ page }) => {
    await page.clock.install();
    await page.goto('/kiosk?inactivityMs=8000');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 境界太郎');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();
    await expect(page.getByTestId('result-connected')).toBeVisible();

    // 閾値未到達では connected 画面のまま（「操作は不要です」の案内どおり、来訪者は操作しない）。
    await page.clock.runFor(7500);
    await expect(page.getByTestId('result-connected')).toBeVisible();

    // 閾値超過で待機へ自動復帰し、前の来訪者の PII を残さない。
    await page.clock.runFor(1000);
    await expect(page.getByTestId('start-reception')).toBeVisible();
  });

  test('日付を跨いでも受付フローが完走する（日付依存の表示崩れ/クラッシュがない）', async ({ page }) => {
    const beforeMidnight = new Date();
    beforeMidnight.setHours(23, 58, 0, 0);
    await page.clock.install({ time: beforeMidnight });
    await page.goto('/kiosk');

    // 4 分進めて日付を跨がせる（この間の heartbeat 再ポーリング等も実時間同様に発火する）。
    await page.clock.runFor('04:00');

    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 日付跨ぎ');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();
    await expect(page.getByTestId('result-connected')).toBeVisible();
    await page.getByTestId('complete').click();
    await expect(page.getByTestId('completed')).toBeVisible();
    await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });
  });
});
