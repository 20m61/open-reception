import { test, expect, expectCheckinState, type Page } from './kiosk-fixtures';

/**
 * QR 受付のアバター字幕の i18n（issue #361 AC「QR 受付が独立した別 UI に見えず、同じ受付体験と
 * して進行する」）。
 *
 * `CheckinShell` は画面の見出し・リードを `makeT(locale)` で訳していたのに、アバター字幕だけ
 * 契約の ja 既定文言（`CHECKIN_MESSAGE_TEXT_JA`）をそのまま渡していた。English を選んだ来訪者は
 * **英語の見出しの隣で日本語の字幕を読む**ことになり、そこだけ別物に見える。
 *
 * `conversation-turn.test.ts` は解決関数（`checkinSubtitleFor`）を固定するが、**シェルが実際に
 * それを注入しているか**は実 DOM でしか分からない（登録簿だけあってズレていれば無意味、という
 * #497 と同じ関心）。ここが消費者になる。
 *
 * 言語は待機画面の `LanguageSwitcher` で選ぶ（`kiosk-escape-bar-i18n.spec.ts` と同じく母国語
 * ラベルで引く＝翻訳文言や実装属性に依存しない）。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

/** QR 受付シェルの字幕。外側に別のアバターが出ても取り違えないようレール内へ絞る。 */
function subtitle(page: Page) {
  return page.getByTestId('checkin-avatar-rail').getByTestId('avatar-subtitle');
}

test('既定 (ja) の QR 受付字幕は日本語で表示される（回帰の固定）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-checkin').click();

  await expect(subtitle(page)).toHaveText('予約 QR をお持ちの方はこちらから受付できます');
});

test('English を選ぶと QR 受付の字幕も英語になり、日本語が露出しない', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-checkin').click();

  await expect(subtitle(page)).toHaveText(
    'If you have a reservation QR code, you can check in here.',
  );

  const text = await subtitle(page).innerText();
  expect(CJK_PATTERN.test(text), `未翻訳の CJK が残っている: ${text}`).toBe(false);
});

test('English のまま読み取りまで進めても、各ターンの字幕が英語で追随する', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-checkin').click();

  // 受付方法選択 → カメラ許可 → 読み取り。ターンが変わるたび字幕が切り替わる。
  await page.getByTestId('checkin-start').click();
  await expect(subtitle(page)).toHaveText('Please choose a check-in method.');

  await page.getByTestId('method-qr').click();
  await expect(subtitle(page)).toHaveText(
    'Please allow camera access so the QR code can be scanned.',
  );

  await page.getByTestId('camera-grant').click();
  // **状態を先に表明する。** 画面 testid だけだと失敗が `element(s) not found` としか出ず、
  // どこへ落ちたのかが分からない（この行が入る前、実際に flaky を 2 度追えなかった）。
  await expectCheckinState(page, 'scanning');
  await expect(page.getByTestId('checkin-scanning')).toBeVisible();
  await expect(subtitle(page)).toHaveText('Hold your reservation QR code up to the camera.');
});

test('English のままエラー画面へ落ちても字幕が英語で出る（困っている来訪者に日本語を出さない）', async ({
  page,
}) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByTestId('start-checkin').click();
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();

  // カメラを使わない → cameraError。翻訳漏れが最も痛いのは行き詰まった局面。
  await page.getByTestId('camera-deny').click();
  await expect(page.getByTestId('checkin-error-cameraError')).toBeVisible();
  await expect(subtitle(page)).toHaveText(
    'The camera could not be used. You can continue with standard check-in.',
  );
});
