import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * QR 受付のエラーが来訪者向けの文言で出る（実ブラウザ） (#736 Gate A / Lane V 代表 5)。
 *
 * ## なぜ今まで踏めなかったか
 *
 * QR の注入口 `?debugScanPayload=` は本番ビルドで無効（token を URL クエリに載せない、
 * という別の正しい判断の帰結）。既定の e2e は `npm run start`＝本番ビルドなので、
 * **QR 受付の成功パスもエラーパスもブラウザで一度も踏まれていなかった** ── 文言・状態機械・
 * サービスは単体で固定されているのに、繋がって画面に出ることは誰も確かめていない。
 *
 * demo-studio の注入（`deriveQrScanner`）は NODE_ENV ゲートを持たず、
 * `qr-checkin-valid` / `qr-expired` のプリセットもある。ただし
 * **シナリオの `initialMode: 'qr'` が `KioskFlow` へ配線されていなかった**ので、
 * 開いても通常受付で起動していた。そこを繋いだうえでここから踏む。
 */
test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test('QR 期限切れ: 来訪者向けの日本語で理由を伝え、行き止まりにしない', async ({ page }) => {
  await page.goto('/admin/demo/preview?scenario=qr-expired');
  // 来訪者の明示操作で読み取りを始める（自動では始めない）。
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();
  await page.getByTestId('camera-grant').click();

  const error = page.getByTestId('checkin-error-expiredError');
  await expect(error).toBeVisible();

  // 🔴 技術的な文言・英語を iPad へ出さない。
  await expect(error).toContainText('有効期限');
  await expect(error).not.toContainText('error');
  await expect(error).not.toContainText('Error');

  // 行き止まりにしない（通常受付へ進める）。
  await expect(page.getByTestId('checkin-error-manual')).toBeVisible();
});

test('QR 有効: 読み取り後に確認画面を経由する（読み取りだけで発信しない）', async ({ page }) => {
  await page.goto('/admin/demo/preview?scenario=qr-checkin-valid');
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();
  await page.getByTestId('camera-grant').click();

  // 🔴 確認画面を必ず経由する。読み取っただけで呼び出しへ進まない。
  await expect(page.getByTestId('checkin-confirm')).toBeVisible();
});

/**
 * QR 受付に無操作リセットが効く (#871)。
 *
 * QR 受付は**受付状態機械を進めない**（`KioskFlow` は `setMode('checkin')` を呼ぶだけで
 * `ReceptionState` は `idle` のまま）。`idle` は `INACTIVITY_RESET_STATES` に無いため、
 * 通常受付では #125 で解決済みの無操作リセットが **QR 経路では一度も発火していなかった**。
 *
 * 放置されるのは予約内容の確認画面 —— 氏名・会社名・予約時刻が出ている画面である。
 * ロビーの iPad にそれが無期限で残り、次の来訪者が読める状態になっていた。
 *
 * 属性や内部状態ではなく、**画面から実際に消えること**で縛る。
 */
test('QR 確認画面を放置すると待機画面へ戻る（予約者の個人情報を残さない）', async ({ page }) => {
  /*
   * ⚠️ **上限を短くしすぎない。** `inactivity.ts` が記録しているとおり、警告までの猶予は
   * `limit - min(INACTIVITY_WARNING_MS, limit - 500)` なので、**limit が 10.5 秒未満だと
   * 猶予は 500ms 固定**になる。そのままだと確認画面へ至るまでの setup クリックの間に
   * 警告オーバーレイが出て、click を横取りして落ちる（実際に一度踏んだ）。
   *
   * `limit = 15000` なら猶予は 5 秒あり、setup の各クリックが `bump` でタイマーを延長する。
   * 最後のクリック後は 5 秒で警告 → 10 秒のカウントダウン → リセットで、実測 15 秒強かかる。
   */
  test.setTimeout(60_000);
  await page.goto('/admin/demo/preview?scenario=qr-checkin-valid&inactivityMs=15000');
  await page.getByTestId('checkin-start').click();
  await page.getByTestId('method-qr').click();
  await page.getByTestId('camera-grant').click();

  const confirm = page.getByTestId('checkin-confirm');
  await expect(confirm).toBeVisible();

  // ここから**一切操作しない**。警告カウントダウンを経て待機へ戻るはず。
  await expect(confirm).toBeHidden({ timeout: 30_000 });
});
