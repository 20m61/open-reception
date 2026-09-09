import { test, expect } from './kiosk-fixtures';
import {
  CHECKOUT_CONFIRM_TIMEOUT_MS,
  CHECKOUT_RESOLVE_TIMEOUT_MS,
} from '@/components/kiosk/checkout/logic';

/**
 * **応答が返らない回線**で、来訪者が退館する手段を失わないこと (#1029)。
 *
 * ## なぜ既存の失敗注入では踏めないか
 *
 * `route.abort()` も 503 も `finally` へ到達するので `busy` は下りる。この族は
 * **サーバが受け取ったまま何も返さない**（ブラックホール）ときにだけ起きる ――
 * Lambda のコールドスタート、NAT の詰まり、テザリング。`busy` は `finally` でしか
 * 下りないので、退館の手段 3 つ（コード送信・QR 送信・在館一覧からの選択）が
 * **全部 `disabled` のまま固まる**。逃げ道の「最初から」も `setBusy(false)` を呼ばない。
 *
 * ## 🔴 締切を e2e のために縮めない
 *
 * 実測に使う値は本番と同じ（`CHECKOUT_RESOLVE_TIMEOUT_MS` / `CHECKOUT_CONFIRM_TIMEOUT_MS`）。
 * #826 で「e2e のためにしきい値を圧縮したら、本番の窓では起きない条件でしか再現しない
 * テストになっていた」を踏んでいる。テストが長くなることを理由に縮めない。
 */

/** 応答を返さない route を張り、teardown 用の解放子を返す。 */
function blackhole(page: import('@playwright/test').Page, pattern: string, method?: 'POST'): {
  release: () => void;
  calls: () => number;
} {
  const releases: Array<() => void> = [];
  let count = 0;
  void page.route(pattern, async (route) => {
    if (method !== undefined && route.request().method() !== method) return route.continue();
    count += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return route.abort('failed');
  });
  return {
    release: () => releases.forEach((r) => r()),
    calls: () => count,
  };
}

test.describe('来訪者導線: 応答が返らなくても退館の手段を失わない (#1029)', () => {
  /**
   * 🔴 **`finally` に到達しない経路があるなら、`disabled` は行き止まりになる。**
   *
   * 5 周目（#1004）で在館一覧の再読み込みボタンについて同じ結論に達したのに、
   * **新設した 1 ボタンにしか適用していなかった**。元からある 3 ボタンはそのままだった。
   */
  test('退館: 自己特定の応答が返らなくても、締切を過ぎれば送信し直せる', async ({ page }) => {
    test.setTimeout(CHECKOUT_RESOLVE_TIMEOUT_MS + 60_000);
    const hung = blackhole(page, '**/api/kiosk/checkout/resolve');

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-code')).toBeVisible();
    await page.getByTestId('checkout-code').fill('1234');
    await page.getByTestId('checkout-target-label').fill('総務部');
    await page.getByTestId('checkout-resolve-submit').click();

    // 踏んだことの表明（要求が飛んでいなければ以降は空虚になる）。
    await expect.poll(() => hung.calls()).toBe(1);

    /*
      **下界。** 締切前は進行中であって、押せてはいけない ―― `disabled` を外すだけの
      「修正」（＝二重送信を許す）でこのテストを通させない。直すのは締切であって
      ガードの撤去ではない。
    */
    await expect(page.getByTestId('checkout-resolve-submit')).toBeDisabled();

    // **これが本題。** 締切を過ぎたら理由が出て、もう一度送れる。
    await expect(page.getByTestId('checkout-error')).toBeVisible({
      timeout: CHECKOUT_RESOLVE_TIMEOUT_MS + 10_000,
    });
    await expect(page.getByTestId('checkout-resolve-submit')).toBeEnabled();
    await page.getByTestId('checkout-resolve-submit').click();
    await expect.poll(() => hung.calls()).toBe(2);

    hung.release();
  });

  /**
   * 🔴 **書き込みの中断は「失敗した」と言い切らない**（#968 が `read-response.ts` に
   * 明文化済み）。中断したのは**こちらの待ち**であって、サーバは退館を受理して監査に
   * 残しているかもしれない。「もう一度お試しください」と促すと、来訪者は
   * **既に退館済みなのに未完だと信じて**操作を繰り返し、`already_checked_out` や
   * `not_found` を踏んで途方に暮れる。成功を否定せず、有人導線を出す（原則 5）。
   */
  test('退館確定: 応答が返らないとき、成功を否定せず受付へ繋ぐ', async ({ page }) => {
    test.setTimeout(CHECKOUT_CONFIRM_TIMEOUT_MS + 60_000);
    const PRESENT = JSON.stringify({
      stays: [
        {
          stayId: 'hang1',
          checkedInAt: '2026-01-01T10:00:00.000Z',
          targetLabel: '総務部',
          purpose: '打ち合わせ',
        },
      ],
    });
    // GET は返し、退館確定の POST だけ握って返さない。
    const releases: Array<() => void> = [];
    let posts = 0;
    await page.route('**/api/kiosk/checkout', async (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: PRESENT });
      }
      posts += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return route.abort('failed');
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    await page.getByTestId('checkout-present-item').first().click();
    await expect(page.getByTestId('checkout-confirm')).toBeVisible();
    await page.getByTestId('checkout-confirm-yes').click();

    // 踏んだことの表明。
    await expect.poll(() => posts).toBe(1);

    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible({ timeout: CHECKOUT_CONFIRM_TIMEOUT_MS + 10_000 });

    // **これが本題。** 成功を否定せず、受付へ繋ぐ。
    await expect(error).toContainText('受付');
    /*
      **下界。** 「通信エラーが発生しました。もう一度お試しください。」（既定の `network`）へ
      倒す変異をここで落とす。退館できたかどうか分からない状態で再試行だけを促さない。
    */
    await expect(error).not.toContainText('もう一度お試しください');

    // デッドロックが解けている（入力を埋めれば送信できる）。
    await page.getByTestId('checkout-code').fill('1234');
    await page.getByTestId('checkout-target-label').fill('総務部');
    await expect(page.getByTestId('checkout-resolve-submit')).toBeEnabled();

    releases.forEach((r) => r());
  });
});
