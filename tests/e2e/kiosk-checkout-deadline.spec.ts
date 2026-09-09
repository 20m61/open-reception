import { test, expect } from './kiosk-fixtures';
import {
  CHECKOUT_CONFIRM_TIMEOUT_MS,
  CHECKOUT_READ_TIMEOUT_MS,
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
 * 実測に使う値は本番と同じ（`CHECKOUT_READ_TIMEOUT_MS` / `CHECKOUT_CONFIRM_TIMEOUT_MS`）。
 * #826 で「e2e のためにしきい値を圧縮したら、本番の窓では起きない条件でしか再現しない
 * テストになっていた」を踏んでいる。テストが長くなることを理由に縮めない。
 */

/**
 * 応答を返さない route を張り、teardown 用の解放子を返す。
 *
 * 🔴 **登録を `await` する**（独立レビュー 1 周目 MINOR-5）。`void page.route(...)` だと
 * 登録完了前に `page.goto` が走りうるので、ブラックホールが張られず
 * `expect.poll(() => calls()).toBe(1)` が落ちる（空虚化ではなく flake）。
 */
async function blackhole(
  page: import('@playwright/test').Page,
  pattern: string,
): Promise<{ release: () => void; calls: () => number }> {
  const releases: Array<() => void> = [];
  let count = 0;
  await page.route(pattern, async (route) => {
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
    test.setTimeout(CHECKOUT_READ_TIMEOUT_MS + 60_000);
    const hung = await blackhole(page, '**/api/kiosk/checkout/resolve');

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
    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible({ timeout: CHECKOUT_READ_TIMEOUT_MS + 10_000 });
    /*
      🔴 **どの理由かまで見る**（独立レビュー 3 周目 MINOR-1 の修正を縛る）。
      「エラーが出た」だけを見ていたので、締切切れを `network` へ戻す変異が生存していた
      （実測）。回線は生きていて**こちらが 15 秒で打ち切っただけ**なので「通信エラー」は
      事実と違い、staff に存在しない障害を疑わせる。両方の文言が
      「もう一度お試しください」で終わるため、**そこだけを見ると区別できない**。
    */
    await expect(error).toContainText('時間内に応答がありませんでした');
    await expect(error).not.toContainText('通信エラー');
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

    /*
      🔴 **`受付` を含むかだけでは緩い**（独立レビュー 3 周目 MAJOR-2）。`checkout.error.*`
      9 種のうち 5 種が `受付` を含み、`もう一度お試しください` を完全一致で含むのは
      `network` だけなので、この対では **5 種のうち 4 種が満たされる** ―― 配線を
      `already_checked_out`（「すでに退館済みです」と**断言**する）へ倒す変異が素通りした。
      退館できたか分からない状況で断言されると、来訪者はそのまま帰り、実際には在館のまま
      かもしれない。実際の文言で照合する。
    */
    await expect(error).toContainText('確認できませんでした');
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
  /**
   * 🔴 **本番でいちばん起きるのは締切ではなく 504 である**（独立レビュー 1 周目 MAJOR-1）。
   *
   * origin（Lambda Function URL）の読み切りは `serverTimeoutSec` と同じ 30 秒なので、
   * サーバがハングしたときブラウザへ**先に届くのは CloudFront の 504** であって、
   * 35 秒の締切ではない。5xx を既定の `network`（「もう一度お試しください」）に残すと、
   * `confirm_unknown` を足した意味が**主経路で失われる** ―― 実際に退館が通っていた場合、
   * 来訪者は再試行して `already_checked_out` / `not_found` を踏むことになる。
   *
   * この 1 本は締切を待たないので速い。**締切の e2e より先にここが落ちる**のが正しい。
   */
  test('退館確定: 504 でも「もう一度」と促さず、退館できたか分からないと伝える', async ({ page }) => {
    const PRESENT = JSON.stringify({
      stays: [
        {
          stayId: 'gw1',
          checkedInAt: '2026-01-01T10:00:00.000Z',
          targetLabel: '総務部',
          purpose: '打ち合わせ',
        },
      ],
    });
    let posts = 0;
    await page.route('**/api/kiosk/checkout', (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: PRESENT });
      }
      posts += 1;
      // CloudFront / ALB が返す 504 は JSON ですらない。
      return route.fulfill({ status: 504, contentType: 'text/html', body: '<html>504</html>' });
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    await page.getByTestId('checkout-present-item').first().click();
    await expect(page.getByTestId('checkout-confirm')).toBeVisible();
    await page.getByTestId('checkout-confirm-yes').click();

    await expect.poll(() => posts).toBe(1);

    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible();
    // **これが本題。** 適用されたか分からないので、断定も再試行の督促もしない。
    await expect(error).toContainText('確認できませんでした');
    await expect(error).toContainText('受付');
    await expect(error).not.toContainText('もう一度お試しください');
  });

  /**
   * 🔴 **下界。** 4xx まで「分からない」へ寄せると、サーバが**見たうえで断った**ことが
   * 伝わらなくなる。「もう退館済みです」と言えるのが正しい状況で受付へ歩かせない。
   */
  test('退館確定: 4xx はサーバが見て断ったので、その理由をそのまま伝える', async ({ page }) => {
    const PRESENT = JSON.stringify({
      stays: [
        {
          stayId: 'dup1',
          checkedInAt: '2026-01-01T10:00:00.000Z',
          targetLabel: '総務部',
          purpose: '打ち合わせ',
        },
      ],
    });
    let posts = 0;
    await page.route('**/api/kiosk/checkout', (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: PRESENT });
      }
      posts += 1;
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: '{"error":"already_checked_out"}',
      });
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    await page.getByTestId('checkout-present-item').first().click();
    await page.getByTestId('checkout-confirm-yes').click();
    await expect.poll(() => posts).toBe(1);

    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('退館');
    // 「分からない」へ寄せる変異をここで落とす。
    await expect(error).not.toContainText('確認できませんでした');
  });

  /**
   * 🔴 **下界。** `confirmFailureFromAbort(true)` 固定にする変異が unit 961 本・
   * e2e 5 本を全部素通りした（独立レビュー 2 周目 MAJOR-3）。締切が切れた側は
   * 上の 2 本が縛っているが、**切れていない側を縛る spec が 1 本も無かった** ――
   * 確定 POST に接続失敗を注入する spec が存在しなかったためである。
   *
   * 実害: iPad が Wi-Fi を落とすと（`kiosk-unverified-200.spec.ts` が「実運用でいちばん
   * 起きる」と名指ししている失敗）、**サーバに一度も届いていない**のに
   * 「退館できたか分かりません。受付へ」と出る。押し直せば済む来訪者を全員受付へ歩かせる。
   * しかも `network` より**強い**言い方なので、誤誘導は増える。
   */
  test('退館確定: 接続そのものが失敗したときは、再試行を促す（受付へ回さない）', async ({ page }) => {
    const PRESENT = JSON.stringify({
      stays: [
        {
          stayId: 'off1',
          checkedInAt: '2026-01-01T10:00:00.000Z',
          targetLabel: '総務部',
          purpose: '打ち合わせ',
        },
      ],
    });
    let posts = 0;
    await page.route('**/api/kiosk/checkout', (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: PRESENT });
      }
      posts += 1;
      // サーバへ届いていない（Wi-Fi 断・DNS 失敗）。締切は切れていない。
      return route.abort('failed');
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    await page.getByTestId('checkout-present-item').first().click();
    await expect(page.getByTestId('checkout-confirm')).toBeVisible();
    await page.getByTestId('checkout-confirm-yes').click();

    await expect.poll(() => posts).toBe(1);

    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible();
    // **これが本題。** 届いていないので、再試行を促してよい。
    await expect(error).toContainText('もう一度お試しください');
    // 「分からない」へ寄せる変異をここで落とす ―― 受付へ歩かせる理由が無い。
    await expect(error).not.toContainText('確認できませんでした');
  });

  /**
   * 🔴 **標準の 1 行締切 API が無い端末で、退館の 3 手段が全滅していた**
   * （独立レビュー 3 周目 BLOCKER-1）。`AbortSignal.timeout` は Safari 16（2022-09）からで、
   * iPadOS 15 以前には無い。`fetch` の引数として評価すると**呼んだ瞬間に投げる**ので、
   * 要求が 1 本も飛ばない。レビューの実測: `gets=0 resolves=0 posts=0`、画面は
   * 「通信エラーが発生しました。もう一度お試しください。」。回線は正常なのに何度押しても同じで、
   * staff は存在しないネットワーク障害を追うことになる。
   *
   * **#1029 は「悪い回線でだけ固まる」を直そうとして「特定の端末クラスで常に失敗する」へ
   * 変換していた。** `docs/ipad-uat.md` の端末方針は「可能な限り最新のメジャー版」＝
   * 努力目標なので、16 以上を前提にできない。
   *
   * この環境には webkit バイナリが無く実機で測れないので、**API を消して再現する**。
   */
  test('退館: 標準の 1 行締切 API が無い端末でも、退館の導線が生きている', async ({ page }) => {
    await page.addInitScript(() => {
      // iPadOS 15 以前の Safari 相当。
      // @ts-expect-error 非対応環境を再現する
      delete AbortSignal.timeout;
    });
    const calls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/kiosk/checkout')) calls.push(req.method());
    });

    await page.goto('/kiosk/checkout');

    // **これが本題。** 要求が実際に飛ぶ（`gets=0` にならない）。
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    // 一覧が読めている＝締切の生成が投げていない。
    await expect(
      page.getByTestId('checkout-present-list').or(page.getByTestId('checkout-empty')),
    ).toBeVisible();
    // 自己特定も飛ぶ。
    await page.getByTestId('checkout-code').fill('1234');
    await page.getByTestId('checkout-target-label').fill('総務部');
    const before = calls.length;
    await page.getByTestId('checkout-resolve-submit').click();
    await expect.poll(() => calls.length).toBeGreaterThan(before);
  });

  /**
   * 🔴 **締切の「値」は静的走査では縛れない**（独立レビュー 3 周目 MAJOR-1）。
   *
   * 台帳の綴りは 3 度替えて 3 度別の書き方で抜けられた（リテラル一致 → 一意束縛 →
   * 行頭でない再代入）。#813（ESLint の文法を手写しして 3 度突破された）と同型なので、
   * **前提の側を替える** ―― 値の効き方を**本番ビルドで観測する**。
   *
   * 確定を 20 秒握ってから成功させる。確定の締切（35s）なら通り、読み取り用（15s）へ
   * 差し替えられていれば**先に切れて失敗する**。サーバの予算は 30 秒なので、
   * 15 秒はそもそも「サーバの答えを先に見る」という設計を壊している。
   */
  test('退館確定: 20 秒かかっても待ち切る（読み取り用の締切へ差し替えられていない）', async ({ page }) => {
    test.setTimeout(CHECKOUT_CONFIRM_TIMEOUT_MS + 60_000);
    const PRESENT = JSON.stringify({
      stays: [
        {
          stayId: 'slow1',
          checkedInAt: '2026-01-01T10:00:00.000Z',
          targetLabel: '総務部',
          purpose: '打ち合わせ',
        },
      ],
    });
    await page.route('**/api/kiosk/checkout', async (route) => {
      if (route.request().method() !== 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: PRESENT });
      }
      // サーバの予算（30s）の内側だが、読み取り用の締切（15s）は超える。
      await new Promise((r) => setTimeout(r, 20_000));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    await page.getByTestId('checkout-present-item').first().click();
    await page.getByTestId('checkout-confirm-yes').click();

    // **これが本題。** 20 秒待ってから成功する。15 秒で切る実装ではここに到達しない。
    await expect(page.getByTestId('checkout-done')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('checkout-error')).toHaveCount(0);
  });

  /**
   * 🔴 **在館一覧にも締切が要る**（独立レビュー 1 周目 MAJOR-3）。
   *
   * 締切が無いと `catch` に到達せず `presentFailed` が永久に false のままになる。
   * 再読み込みボタンは `presentFailed` のときだけ描画されるので、**押せるボタンが
   * 1 つも無いまま「確認しています…」と言い続ける**（レビューの実測: 20 秒後も
   * `checkout-present-retry` は 0 件）。#870 / #896 が 2 度閉じた「永遠の読み込み中」と同型。
   */
  test('退館: 在館一覧の応答が返らなくても、締切を過ぎれば再読み込みが出る', async ({ page }) => {
    test.setTimeout(CHECKOUT_READ_TIMEOUT_MS + 60_000);
    const hung = await blackhole(page, '**/api/kiosk/checkout');

    await page.goto('/kiosk/checkout');
    await expect.poll(() => hung.calls()).toBe(1);

    // 締切前は「確認しています…」であって、失敗表示ではない（下界）。
    await expect(page.getByTestId('checkout-present-loading')).toBeVisible();
    await expect(page.getByTestId('checkout-present-retry')).toHaveCount(0);

    // **これが本題。** 締切を過ぎたら失敗として出て、押せるものが現れる。
    await expect(page.getByTestId('checkout-present-unavailable')).toBeVisible({
      timeout: CHECKOUT_READ_TIMEOUT_MS + 10_000,
    });
    await expect(page.getByTestId('checkout-present-retry')).toBeEnabled();

    hung.release();
  });
});
