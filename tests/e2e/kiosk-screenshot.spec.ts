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
 *  - `maxDiffPixelRatio` は **0.002**。かつて 0.02 だったが、**それが実際に退行を隠していた**
 *    （第 95 wave）。待機カードの並びが #422 inc5-b で `担当者を呼ぶ → QR で受付 → …` から
 *    `… 用件 4 種 → QR で受付` へ変わったのに、darwin ベースラインは旧並びのまま**通り続けて
 *    いた** — カードの位置は同じで中身の文字とアイコンだけが入れ替わるため、差分は
 *    4900px / 12319px（実比 ~0.006）にしかならず 0.02 の内側に収まっていた。
 *    同一プラットフォームでの再撮影は**実測でノイズ 0**（`maxDiffPixelRatio: 0` で 12 連続 pass）。
 *    ベースラインは `{platform}` 込みの名前で OS ごとに分かれており、緩い許容値は
 *    フォント差の吸収にはもう要らない。0.002 は実測ノイズに対して十分な余裕があり、
 *    かつ上記 ~0.006 の退行を捕まえられる。**緩めるときは何を見逃すかを数値で確かめること。**
 *  - PII を含まない待機画面のみを対象にする（個人情報を baseline 画像へ焼き込まない）。
 *
 * **VRT は「今の見た目」を固定するだけで、それが正しいかは判定しない。** #617 の
 * `ipad-landscape` baseline は、見出しの末尾「い」が「見やすさ設定」ボタンに隠れた状態を
 * そのまま焼き付けていた。テスト名は「レイアウトが崩れない」だが、**崩れたまま通り続けて
 * いた**。読めるかどうかのような**満たすべき性質は、別途アサーションで書く**こと
 * （`kiosk-idle-title-clearance.spec.ts` は行矩形とボタン矩形の交差面積で判定する）。
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
      maxDiffPixelRatio: 0.002,
    });
  });
}
