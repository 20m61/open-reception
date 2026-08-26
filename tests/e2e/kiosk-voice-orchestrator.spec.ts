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

  // 音声レイヤがマウントされている（＝ factory が渡り、start() が通っている）。
  await expect(page.getByTestId('voice-layer')).toBeVisible();

  // 🔴 **待機画面で聞き取りへ進んでいないこと** (#788)。以前はここで
  // `voice-listening-indicator` が出るのを「起動した証拠」にしていたが、それは
  // **合成発話が idle で走っていた**という不具合そのものを正解として書いていた。
  // 来訪者が一言も発していないのに相手が確定しうる（候補 1 件・高信頼なら復唱も挟まない）。
  await expect(page.getByTestId('voice-layer')).toHaveAttribute('data-voice-mode', 'idle');
  await expect(page.getByTestId('voice-listening-indicator')).toHaveCount(0);

  // 起動によって受付導線が壊れないこと。ここが本質 —— 音声を足したせいで
  // タッチで受付できなくなるなら、フラグ以前の問題になる。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  expect(errors, `page errors: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 音声で相手が選べること (#788)。
 *
 * これが本題。`EntityDirectory` が空配列だった間、配線（音声確定 → `voiceCandidateToTarget`
 * → `SELECT_TARGET`）は正しいのに**候補ゼロで必ず聞き直し**になり、音声では誰も選べなかった。
 * ソースを読むとタッチと等価に見えるので、**振る舞いで縛らないと同じ形へ戻る**。
 *
 * 合成発話の起点は相手選択への到達（`notifyReceptionState('selectingTarget')`）。ここでは
 * タッチで相手選択画面まで進み、**担当者カードを一切押さずに**次の画面へ進むことを見る。
 */
test('?voiceOrchestrator=1 で、担当者を押さずに音声だけで相手が決まる', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 相手選択へ到達すると合成発話がターン確定まで通り、SELECT_TARGET が撃たれる。
  // **担当者カードは一度も押さない**（押さないので `staff-*` の可視待ちも入れない ──
  // 音声の確定が速いと、待っている間にカードごと次の画面へ置き換わる）。
  await expect(page.getByTestId('visitor-name')).toBeVisible();

  // 🔴 **画面が進んだことだけでは足りない。** 相手が実際に入っていることを確認画面で見る
  // （`SELECT_TARGET` の target が空でも遷移だけはしうる）。
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-target')).not.toBeEmpty();
});
