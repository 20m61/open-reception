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
 * 合成発話の起点は相手選択への到達（`notifyReceptionState('selectingTarget')`）。確定は
 * **復唱確認を挟む** ── 自動採用にすると相手選択画面が 1 フレームで消え、別の相手に
 * 会いに来た来訪者がタッチで選ぶ間も、取り消す口も無くなる（理由は `local-mode.ts` の
 * `LOCAL_SYNTHETIC_STT_CONFIDENCE`）。
 */
test('?voiceOrchestrator=1 で、担当者を押さずに音声だけで相手が決まる', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 🔴 **相手選択画面は消えない。** 復唱が出ている間もタッチで別の相手を選べること。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();

  // 見える応答（復唱）が出る。無言で相手が決まらない。名前は字幕側に出る
  // （`voice-readback` は「はい／いいえ」のボタン行）。
  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await expect(page.getByTestId('voice-caption')).toContainText('佐藤 太郎');

  // 「はい」で初めて相手が確定する。ここまで担当者カードは一度も押していない。
  await page.getByTestId('voice-confirm-yes').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();

  // 🔴 **画面が進んだことだけでは足りない。** 相手が実際に入っていることを確認画面で見る
  // （`SELECT_TARGET` の target が空でも遷移だけはしうるし、部署が入っていても空ではない）。
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-target')).toHaveText(/佐藤 太郎/);
});

/**
 * 「いいえ」で取り消せること (#788 レビュー 2 周目)。
 *
 * 復唱を挟む意味は、来訪者が**違うと言える**ことにある。取り消し口が死ぬと、
 * 自動採用へ戻したのと実質同じになる。
 */
test('?voiceOrchestrator=1 で、復唱に「いいえ」と答えたら相手は決まらない', async ({ page }) => {
  await page.goto('/kiosk?voiceOrchestrator=1');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await page.getByTestId('voice-confirm-no').click();

  // 相手選択に留まり、タッチで自分の相手を選べる。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('visitor-name')).toHaveCount(0);
});
