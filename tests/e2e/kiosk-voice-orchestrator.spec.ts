import { test, expect } from './kiosk-fixtures';

/**
 * 実 orchestrator のローカル起動 (#372 配線)。
 *
 * `VoiceSessionOrchestrator`（ターン検出・barge-in・TTS duck/stop・VRM 同期）は実装も
 * unit テストも揃っていたが**本番呼び出し元がゼロ**で、一度も起動していなかった。
 * `?voiceOrchestrator=1` で mock provider 駆動の実 orchestrator を通す。
 */

/** **既定はオフ。** これが崩れると、全端末の音声挙動が黙って変わる。 */
test('フラグ無しでは音声レイヤが出ない（既存挙動を変えない）', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-idle')).toBeVisible();
  await expect(page.getByTestId('voice-listening-indicator')).toHaveCount(0);
});

test('?voiceOrchestrator=1 で実 orchestrator が起動し、受付が壊れない', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/kiosk?voiceOrchestrator=1');
  await expect(page.getByTestId('kiosk-idle')).toBeVisible();

  // 音声レイヤがマウントされ、実 orchestrator が listening 状態を出す
  // （＝ factory が渡り、start() が通っている）。
  await expect(page.getByTestId('voice-listening-indicator')).toBeVisible();

  // 起動によって受付導線が壊れないこと。ここが本質 —— 音声を足したせいで
  // タッチで受付できなくなるなら、フラグ以前の問題になる。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  expect(errors, `page errors: ${errors.join(' / ')}`).toEqual([]);
});
