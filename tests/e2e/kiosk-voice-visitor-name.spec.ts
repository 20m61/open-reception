import { test, expect, revealStaff } from './kiosk-fixtures';
import type { Page } from '@playwright/test';
import { openVoiceNameKiosk as openKiosk, spokenTexts } from './voice-name-helpers';

/**
 * 音声で来訪者の氏名を聞き取り、復唱を経て確定する (ADR 0011、#1290)。合成データだけを使う。
 *
 * 音声は `?voiceOrchestrator=1`（実 orchestrator を mock provider で駆動する検証用の経路）と、
 * 合成の名乗り `?voiceVisitorName=` で再現する。読み上げ（`speechSynthesis`）は headless では
 * 終わりの通知が来ないので、読んだ文を記録して終わりを返す代役へ差し替える
 * （`TTS_FAILS` のときは失敗を返す）。TTS の有効化は `/api/kiosk/voice` の応答だけを差し替える
 * （端末の設定は書き換えない。他の spec へ漏れない）。
 *
 * 画面の画像は `screenshots/kiosk-voice-name/` へ保存する（レビュー用。回帰比較ではない）。
 */
const SHOTS = 'screenshots/kiosk-voice-name';

/** 相手まで進める（相手は音声の復唱を「はい」で確定する。#788 の経路）。 */
async function toVisitorInfo(page: Page): Promise<void> {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('voice-readback')).toBeVisible();
  await page.getByTestId('voice-confirm-yes').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
}

const voiceMode = (page: Page) => page.getByTestId('voice-layer');

test.describe('音声で氏名を聞き取る (ADR 0011、#1290)', () => {
  test.use({ viewport: { width: 1080, height: 810 } });

  test('通知を読み終えてから尋ね、復唱し、「はい」で確認画面へ進む（発信はしない）', async ({ page }) => {
    await openKiosk(page, { visitorName: '受付 太郎です' });
    await toVisitorInfo(page);

    // 復唱（画面の表示と読み上げの両方）。確定はまだ。
    await expect(page.getByTestId('voice-caption')).toHaveText('受付 太郎様でよろしいですか？');
    await expect(page.getByTestId('visitor-name')).toHaveValue('');
    const spoken = await spokenTexts(page);
    const notice = spoken.findIndex((t) => t.startsWith('受付のため、お名前をお伺いします。'));
    const readback = spoken.indexOf('受付 太郎様でよろしいですか？');
    expect(notice, `読み上げ: ${spoken.join(' / ')}`).toBeGreaterThanOrEqual(0);
    expect(readback).toBeGreaterThan(notice);
    await page.screenshot({ path: `${SHOTS}/02-readback.png` });

    await page.getByTestId('voice-confirm-yes').click();
    await expect(page.getByTestId('confirm-name')).toHaveText('受付 太郎');
    // 発信の直前の確認はタッチの 1 か所だけ。音声で確定しても呼び出しへは進まない。
    await expect(page.locator('[data-kiosk-state]')).toHaveAttribute('data-kiosk-state', 'confirming');
    await page.screenshot({ path: `${SHOTS}/03-confirm.png` });
  });

  test('通知の読み上げ中・尋ねている最中の画面（聞き取りを待つ）', async ({ page }) => {
    await openKiosk(page);
    await toVisitorInfo(page);
    await expect(page.getByTestId('voice-caption')).toHaveText('お名前をお話しください');
    await expect(page.getByTestId('privacy-notice-summary')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-asking.png` });
  });

  test('「いいえ」なら氏名から聞き直す', async ({ page }) => {
    await openKiosk(page, { visitorName: '受付 太郎です' });
    await toVisitorInfo(page);
    await expect(page.getByTestId('voice-readback')).toBeVisible();
    await page.getByTestId('voice-confirm-no').click();
    // 合成の名乗りがすぐ流れるので、言い直しの字幕か次の復唱のどちらかになる。言い直しを数える。
    await expect
      .poll(async () => (await spokenTexts(page)).filter((t) => t === 'もう一度、お名前をお話しください').length)
      .toBe(1);
    await expect(page.getByTestId('visitor-name')).toHaveValue('');
    await page.screenshot({ path: `${SHOTS}/04-retry.png` });
  });

  test('言い直しが尽きたら、キーボードへフォーカスを移して案内する', async ({ page }) => {
    // 上限（50 文字）を超える名乗りは毎回失敗になる。
    await openKiosk(page, { visitorName: 'あ'.repeat(51) });
    await toVisitorInfo(page);
    await expect(voiceMode(page)).toHaveAttribute('data-voice-mode', 'keyboardGuide');
    await expect(page.getByTestId('voice-caption')).toContainText('お名前は画面から入力してください');
    await expect(page.getByTestId('visitor-name')).toBeFocused();
    await expect(page.getByTestId('visitor-name')).toHaveValue('');
    await page.screenshot({ path: `${SHOTS}/05-keyboard-guide.png` });

    // キーボードだけで最後まで進める。
    await page.getByTestId('visitor-name').fill('受付 花子');
    await page.getByTestId('to-confirm').click();
    await expect(page.getByTestId('confirm-name')).toHaveText('受付 花子');
  });

  test('打ち始めたら聞き取りと復唱を止める（音声が入力を上書きしない）', async ({ page }) => {
    await openKiosk(page);
    await toVisitorInfo(page);
    await expect(voiceMode(page)).toHaveAttribute('data-voice-mode', 'listening');
    await page.getByTestId('visitor-company').fill('合成商事');
    await expect(voiceMode(page)).toHaveAttribute('data-voice-mode', 'idle');
    await expect(page.getByTestId('voice-caption')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/06-typing-stops-voice.png` });
  });

  test('通知を読み上げられないときは、音声で尋ねない（キーボードで最後まで進める）', async ({ page }) => {
    await openKiosk(page, { visitorName: '受付 太郎です', ttsFails: true });
    await toVisitorInfo(page);
    // 尋ねる字幕も復唱も出ない。
    await page.waitForTimeout(500);
    await expect(page.getByTestId('voice-caption')).toHaveCount(0);
    await expect(page.getByTestId('voice-readback')).toHaveCount(0);
    await page.getByTestId('visitor-name').fill('受付 太郎');
    await page.getByTestId('to-confirm').click();
    await expect(page.getByTestId('confirm-name')).toHaveText('受付 太郎');
  });

  test('確認画面から戻ったときは、通知も聞き取りも自動で始めない', async ({ page }) => {
    await openKiosk(page, { visitorName: '受付 太郎です' });
    await toVisitorInfo(page);
    await page.getByTestId('voice-confirm-yes').click();
    await expect(page.getByTestId('confirm-name')).toHaveText('受付 太郎');
    const before = (await spokenTexts(page)).length;
    await page.getByTestId('escape-back').click();
    await expect(page.getByTestId('visitor-name')).toHaveValue('受付 太郎');
    await page.waitForTimeout(500);
    expect((await spokenTexts(page)).slice(before).some((t) => t.includes('お名前をお伺いします'))).toBe(false);
    await expect(page.getByTestId('voice-readback')).toHaveCount(0);
  });

  test('不在の人を名指ししたら、無言で聞き直さずに不在を告げる', async ({ page }) => {
    await openKiosk(page, { target: '鈴木 花子', unavailableStaffId: 'staff-suzuki' });
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await expect(voiceMode(page)).toHaveAttribute('data-voice-mode', /unavailable|readback/);
    await expect(page.getByTestId('voice-caption')).toContainText('鈴木 花子');
    await page.screenshot({ path: `${SHOTS}/07-unavailable-target.png` });
  });
});

test.describe('氏名の上限（キーボード）', () => {
  test.use({ viewport: { width: 1080, height: 810 } });

  test('51 文字は送れず理由を示し、50 文字は送れる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();

    await page.getByTestId('visitor-name').fill('あ'.repeat(51));
    await expect(page.getByTestId('visitor-name-too-long')).toHaveText('お名前は50文字以内で入力してください');
    await expect(page.getByTestId('to-confirm')).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/08-name-too-long.png` });

    await page.getByTestId('visitor-name').fill('あ'.repeat(50));
    await expect(page.getByTestId('visitor-name-too-long')).toHaveCount(0);
    await expect(page.getByTestId('to-confirm')).toBeEnabled();
  });

  test('前後のゼロ幅文字は送る値に入らない', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('​受付 太郎​');
    await page.getByTestId('to-confirm').click();
    expect(await page.getByTestId('confirm-name').textContent()).toBe('受付 太郎');
  });
});
