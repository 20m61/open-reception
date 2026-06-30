import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 受付端末のフォールバック継続ゲート E2E (issue #125 / Epic #119)。
 *
 * 検証する不変条件:
 *  - 音声(TTS)・カメラ・VRM アバター・モーション等の任意サブシステムが使えなくても、
 *    タッチ主導線の受付フローは待機 → 完了まで完走する。
 *
 * これらは受付の主導線ではなく補助演出のため、ブラウザレベルの非対応/権限拒否や
 * 設定取得失敗が起きても、KioskFlow は catch して継続する（劣化しても止めない）。
 */

/** 待機から完了まで、タッチ操作だけで受付を完走する。 */
async function runReceptionToComplete(page: Page) {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 四郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();
  await expect(page.getByTestId('completed')).toBeVisible();
}

test('音声・カメラ・アバターが使えない環境でも受付を完走できる', async ({ page }) => {
  // ブラウザレベルでカメラと音声合成を不能にする（権限拒否・非対応相当）。
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('camera denied'));
    }
    // 音声合成を呼ぶと例外を投げる環境を模す。
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak() {
          throw new Error('tts unavailable');
        },
        cancel() {},
      },
    });
  });
  // アバター/音声/モーションの設定取得も失敗させる（補助演出のロードが全滅した状態）。
  for (const path of ['**/api/kiosk/voice', '**/api/kiosk/assets', '**/api/kiosk/motions']) {
    await page.route(path, (route) => route.abort());
  }

  await page.goto('/kiosk');
  await runReceptionToComplete(page);
});
