import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin } from './helpers';

/**
 * 管理画面（desktop）の Visual Regression + アクセシビリティ検査
 * （issue #423 受入条件「視覚回帰は iPad landscape と **desktop admin** を対象にする」）。
 *
 * **これまで admin の baseline は 1 枚も無かった。** VRT は kiosk のみ（`kiosk-vrt-a11y` /
 * `kiosk-screenshot`）で、管理画面はレイアウトが壊れても誰も気づかない状態だった。
 * #423 でヘッダに対象拠点を足した（＝ヘッダの要素が増えた）ので、ここを固定する価値が出た。
 *
 * 対象の選び方（**非決定的な画面を入れない**）:
 *  - 拠点別の設定画面を選ぶ。ヘッダの「対象テナント + 対象拠点」が写るので、#423 が入れた
 *    常設表示の回帰がそのまま画像で止まる。
 *  - **ダッシュボードや端末一覧は入れない**。稼働状況（`lastSeenAt` 由来のオンライン判定）や
 *    利用量が時間で動くため、baseline が毎回ずれる。時計を含む画面を VRT に入れないのは
 *    `kiosk-vrt-a11y` のサイネージと同じ判断。
 *
 * baseline は `{platform}` 込みの名前で OS ごとに分かれる（`playwright.config.ts`）。
 * **darwin と linux の両方を置く**こと。片方だけ更新すると、もう片方の環境（週次 Routine は
 * linux）で決定的に落ちる。
 */

/** desktop admin の基準ビューポート。iPad project 上で上書きする。 */
const DESKTOP = { width: 1440, height: 900 } as const;

test.use({ viewport: DESKTOP, deviceScaleFactor: 1, reducedMotion: 'reduce' });

const SHOT_BASE = { animations: 'disabled', maxDiffPixelRatio: 0.002 } as const;

/** 撮る前に状態を 1 つに決める（フォーカス・スクロール・hover）。 */
async function stabilize(page: Page): Promise<void> {
  // hover は `.card:hover` 等でレイアウトを動かすので、カーソルを画面外へ退避する（#553）。
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
    window.scrollTo(0, 0);
  });
}

async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

function summarize(violations: Awaited<ReturnType<typeof blockingViolations>>): string {
  return violations.map((v) => `${v.id}(${v.impact}, nodes=${v.nodes.length})`).join(', ');
}

test.describe('管理画面（desktop）の VRT + a11y (#423)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('営業時間設定（拠点別・ヘッダに対象テナント/対象拠点）', async ({ page }) => {
    await page.goto('/admin/operating-hours?siteId=default-site');
    // ヘッダの対象拠点が確定してから撮る（確定前は出さない仕様なので、待たないと
    // 「チップが無い状態」が baseline になる）。
    await expect(page.getByTestId('active-site')).toContainText('本社受付');
    await expect(page.getByTestId('operating-hours-site-select')).toHaveValue('default-site');

    await stabilize(page);
    await expect(page).toHaveScreenshot('admin-desktop-operating-hours.png', SHOT_BASE);

    const violations = await blockingViolations(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('取次ルート設定（拠点別）', async ({ page }) => {
    await page.goto('/admin/call-routing?siteId=default-site');
    await expect(page.getByTestId('active-site')).toContainText('本社受付');
    await expect(page.getByTestId('call-routing-site-select')).toHaveValue('default-site');

    await stabilize(page);
    await expect(page).toHaveScreenshot('admin-desktop-call-routing.png', SHOT_BASE);

    const violations = await blockingViolations(page);
    expect(violations, summarize(violations)).toEqual([]);
  });

  test('拠点次元を持たない画面ではヘッダに対象拠点が出ない', async ({ page }) => {
    // #423 の「無い区別を作らない」を**画像でも**固定する。ヘッダの構成が変わったときに
    // 拠点チップが漏れ出していれば差分になる。
    await page.goto('/admin/departments');
    await expect(page.getByTestId('active-site')).toHaveCount(0);

    await stabilize(page);
    await expect(page).toHaveScreenshot('admin-desktop-departments.png', SHOT_BASE);

    const violations = await blockingViolations(page);
    expect(violations, summarize(violations)).toEqual([]);
  });
});
