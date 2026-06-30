import { test, expect } from './kiosk-fixtures';

/**
 * 受付端末 待機画面の主要 viewport スクリーンショット差分 (issue #124 / #125 / Epic #119)。
 *
 * iPad 縦/横・大型横画面で待機画面のレイアウトが破綻しないことを画像差分で固定する。
 *
 * 運用方針:
 *  - 本プロジェクトは CI を使わずローカル品質ゲートで担保するため、baseline はこの開発機
 *    （chromium-ipad / darwin）で生成・検証するローカル専用とする。別環境ではフォント描画差で
 *    差分が出るため、別環境で回す場合は `--update-snapshots` で baseline を取り直す。
 *  - フォント/レイアウトの軽微な描画差を許容するため maxDiffPixelRatio を緩める。
 *  - PII を含まない待機画面のみを対象にする（個人情報を baseline 画像へ焼き込まない）。
 */

const VIEWPORTS = [
  { layout: 'ipad-portrait', width: 810, height: 1080 },
  { layout: 'ipad-landscape', width: 1080, height: 810 },
  { layout: 'large-display', width: 1920, height: 1080 },
] as const;

for (const vp of VIEWPORTS) {
  test(`待機画面のレイアウトが崩れない（${vp.layout}）`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/kiosk');

    // レイアウトプロファイルが確定し、主要操作（受付開始）が表示されてから撮影する。
    await expect(page.locator('main[data-kiosk-layout]')).toHaveAttribute(
      'data-kiosk-layout',
      vp.layout,
    );
    await expect(page.getByTestId('start-reception')).toBeVisible();
    await expect(page.getByTestId('idle-guidance')).toBeVisible();

    await expect(page).toHaveScreenshot(`kiosk-idle-${vp.layout}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    });
  });
}
