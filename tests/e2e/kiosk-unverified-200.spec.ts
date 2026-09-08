import { test, expect, revealStaff, type Page } from './kiosk-fixtures';

/**
 * **形は正しい JSON だが、その画面の型ではない 200** を来訪者導線へ注入する (#1004 増分 2)。
 *
 * ## なぜ e2e が要るか
 *
 * 述語そのものは `src/domain/reception/parse.test.ts` /
 * `src/components/kiosk/checkout/parse.test.ts` が固定している。**繋がっていないのはその間**
 * である ―― 増分 1（PR #1011）では「純関数に 5 種当てて 5/5 kill」と報告したのに
 * **配線を変異させておらず**、配線を戻す変異が unit・e2e とも全生存していた（独立レビューの
 * 実測）。ここは配線を縛るためにある。
 *
 * ## なぜ 500 や接続断では踏めないか
 *
 * この族は `res.ok` が真で `fetch` も throw しない。既存の失敗注入（500 / abort）は
 * どちらも別の枝を通るので、**この経路には一度も入らない**。
 *
 * 🔴 **`page.on('pageerror')` を「画面が落ちていない」のオラクルにしない。** root に
 * `global-error.tsx` があるので描画例外はエラー境界に捕まり、**発火しない**（増分 1 で実測）。
 * 実害は「来訪者に『受付を続けられませんでした』が出る」ことなので、その見出しが
 * 出ていないことを直接見る。
 */

/** 形は JSON だが、その画面の型ではない 200。 */
const WRONG_SHAPE = '{"ok":true}';

async function respondWrongShape(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: WRONG_SHAPE }),
  );
}

/** 来訪者向けの致命画面（root の `global-error.tsx`）が出ていないこと。 */
async function expectNotCrashed(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
}

test.describe('来訪者導線: 形の違う 200 で受付・退館を止めない (#1004)', () => {
  /**
   * 🔴 **退館一覧が落ちると、退館画面ごと使えなくなる。**
   *
   * `stays` が欠けた 200 で `setPresent(undefined)` が走り、次のレンダーの `present.length`
   * が TypeError を投げる。`/kiosk/checkout` に error boundary は無いので root まで上がる。
   */
  test('退館: 一覧の形が違っても画面が落ちず、QR/コードで退館できる', async ({ page }) => {
    /*
      🔴 **踏んだことを主張する**（独立レビュー 1 周目 MINOR-1）。これが無いと、
      `loadPresent` の冒頭に早期 return を入れて **GET を 1 度も飛ばさない**変異でも
      緑のままだった（レビューの実測）。K2 で学んだのと同じ形が、この 1 本にも残っていた。
    */
    const listCalls: string[] = [];
    page.on('request', (req) => {
      if (/\/api\/kiosk\/checkout(\?|$)/.test(req.url())) listCalls.push(req.method());
    });

    await respondWrongShape(page, '**/api/kiosk/checkout');
    await page.goto('/kiosk/checkout');

    await expect.poll(() => listCalls.length).toBeGreaterThan(0);
    await expectNotCrashed(page);

    /*
      **下界。** 「落ちない」だけだと、画面全体を出さない実装でも通る。一覧取得の失敗は
      致命的でない（QR/コードで退館できる）というのが元の設計なので、**入力手段が
      残っていること**まで主張する。
    */
    await expect(page.getByTestId('checkout-code')).toBeVisible();

    /*
      🔴 **取得できていないことを、在館者がいないことと言い換えない**
      （独立レビュー 3 周目 MAJOR-A）。この増分は当初、`stays` が読めないときの
      **クラッシュ**を消した結果「在館中の来訪者はいません。」と**断言する**画面にして
      いた ―― **大声の失敗を沈黙の誤情報へ変換**していた。この一覧は staff が来訪者を
      照合する材料なので、「いません」は人の取り違えに直結する。
      #870 / #973 が管理画面で潰したのと同じ型を、来訪者導線に作っていた。
    */
    await expect(page.getByTestId('checkout-present-unavailable')).toBeVisible();
    await expect(page.getByTestId('checkout-empty')).toHaveCount(0);
    // 理由だけでなく手段も出す（#870 が 7 画面へ機械要求しているのと同じ規約）。
    await expect(page.getByTestId('checkout-present-retry')).toBeEnabled();
  });

  /**
   * 🔴 **実運用でいちばん起きるのは 503 / 通信断**（独立レビュー 4 周目 MAJOR-4）。
   * 形の違う 200 の枝だけを縛っていたので、`!res.ok` で黙る変異が生存していた。
   */
  test('退館: 一覧が 503 でも「いません」と断言しない', async ({ page }) => {
    await page.route('**/api/kiosk/checkout', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }),
    );
    await page.goto('/kiosk/checkout');

    await expect(page.getByTestId('checkout-present-unavailable')).toBeVisible();
    await expect(page.getByTestId('checkout-empty')).toHaveCount(0);
    await expect(page.getByTestId('checkout-present-retry')).toBeEnabled();
    await expect(page.getByTestId('checkout-code')).toBeVisible();
  });

  /**
   * 🔴 **提示した手段が実際に効くこと**（独立レビュー 4 周目 MAJOR-4）。
   * 再読み込みの `onClick` を no-op にする変異が生存していた ―― `toBeEnabled()` は
   * **死んだボタンでも真**になる。押して回復するところまで見る（下界）。
   */
  test('退館: 一覧の再読み込みが回復すると一覧が出る', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (req) => {
      if (/\/api\/kiosk\/checkout(\?|$)/.test(req.url())) calls.push(req.method());
    });
    // 1 回目だけ落とす。
    let failed = false;
    await page.route('**/api/kiosk/checkout', (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-present-unavailable')).toBeVisible();

    await page.getByTestId('checkout-present-retry').click();
    // 押した結果 GET が実際に飛ぶ（死んだボタンなら増えない）。
    await expect.poll(() => calls.length).toBeGreaterThan(1);
    // 回復したら失敗表示は消える（`setPresentFailed(false)` を消す変異がここで落ちる）。
    await expect(page.getByTestId('checkout-present-unavailable')).toHaveCount(0);
  });

  /**
   * 🔴 **一度載った一覧を、再取得の失敗で消さない**（独立レビュー 4 周目 MAJOR-1）。
   *
   * 3 周目の修正が作った退行。`presentFailed` を `present` より優先していたので、
   * ネットワークが一瞬揺れただけで**有効なデータを持ったまま画面から消えて**いた。
   * 退館完了 6 秒後の `resetToIdentify` が自動で `loadPresent` を呼ぶので、
   * 意図的な操作なしに踏む。`src/domain/ui/read-state.ts` が #870 で
   * 「載っていることを優先する」と明文化していたのに、手で導き直して外していた。
   */
  test('退館: 再取得に失敗しても、載っている一覧を消さない', async ({ page }) => {
    // seed の在館者数に依存しない（共有状態も書かない。#787）。1 回目だけ在館者を返す。
    const LOADED = JSON.stringify({
      stays: [
        { stayId: 's1', checkedInAt: '2026-01-01T09:00:00.000Z', targetLabel: '総務部', purpose: '打ち合わせ' },
        { stayId: 's2', checkedInAt: '2026-01-01T10:00:00.000Z' },
      ],
    });
    let calls = 0;
    await page.route('**/api/kiosk/checkout', (route) => {
      calls += 1;
      return calls === 1
        ? route.fulfill({ status: 200, contentType: 'application/json', body: LOADED })
        : route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/kiosk/checkout');
    // 一覧が載るまで待つ（載っていないと「消さない」を測れない＝空虚になる）。
    await expect(page.getByTestId('checkout-present-list')).toBeVisible();
    const before = await page.getByTestId('checkout-present-item').count();
    expect(before).toBeGreaterThan(0);

    // 逃げ道から戻ると `loadPresent` が再実行される（自動リセットと同じ経路）。
    await page.getByTestId('checkout-start-over').click();
    await expect(page.getByTestId('checkout-present-unavailable')).toBeVisible();

    // **これが本題。** 失敗は添えるだけで、載っているものは消さない。
    await expect(page.getByTestId('checkout-present-item')).toHaveCount(before);
  });

  /**
   * 🔴 **確認画面は「退館する」を押す直前である。**
   *
   * `summary` が欠けた 200 を通すと `pending.summary.checkedInAt` が throw する。
   * 一覧と違ってここは**退館そのものの導線**なので、落ちると来訪者は退館できない。
   */
  test('退館: 自己特定の応答の形が違っても落ちず、理由が出る', async ({ page }) => {
    /*
      🔴 **要求が実際に飛んだことを観測する。**

      最初に書いたこのテストは**完全に空虚だった**（変異が生存して判明）。退館コードは
      `CHECKOUT_CODE_LENGTH = 4` 桁必須で、6 桁を入れていたので `normalizeCheckoutCode` が
      null を返し、**resolve へ 1 度も要求が飛んでいなかった**。それでも下の 3 本は
      クライアント側検証だけで満たされる（エラーは出る・確認画面へは進まない・落ちない）
      ので、**修正の有無にかかわらず通っていた**。

      増分 1 の 5 周目と同じ型である ―― 別の機構が保証している結果をオラクルにすると、
      測りたい経路を一度も踏まずに緑になる。**踏んだことを先に主張する。**
    */
    const resolveCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/kiosk/checkout/resolve')) resolveCalls.push(req.method());
    });

    await respondWrongShape(page, '**/api/kiosk/checkout/resolve');
    await page.goto('/kiosk/checkout');
    await expect(page.getByTestId('checkout-code')).toBeVisible();

    // コード経路は「退館コード（**4 桁**）」と「呼び出し先」の両方が要る。
    await page.getByTestId('checkout-code').fill('1234');
    await page.getByTestId('checkout-target-label').fill('総務部');
    await page.getByTestId('checkout-resolve-submit').click();

    // **踏んだことの表明。** これが無いと、以降の 3 本はクライアント側検証でも満たされる。
    await expect.poll(() => resolveCalls.length).toBeGreaterThan(0);

    await expectNotCrashed(page);
    // 黙って入力画面に留まらせない（何が起きたか分からないまま押し続けることになる）。
    const error = page.getByTestId('checkout-error');
    await expect(error).toBeVisible();
    /*
      🔴 **理由の選択まで縛る。** 「エラーが出た」だけを見ていると、理由を `invalid` へ
      戻す変異が素通りする（実測で生存した）。`invalid` は
      (1) **来訪者の入力のせいにし**（「受付番号を入力してください」）
      (2) いまの画面に無い欄を指し（#328 で「退館コード」と「呼び出し先」に変わった）
      (3) 再試行では直らないのに**有人導線が無い**。
      応答が読めなかったのは来訪者の落ち度ではないので、`expired` / `throttled` と同じく
      受付への導線を出す（`docs/experience/README.md` 原則 5）。
    */
    await expect(error).toContainText('受付にお問い合わせください');
    await expect(error).not.toContainText('受付番号を入力してください');
    /*
      ⚠️ **「見えているか」はここでは主張しない**（独立レビュー 3 周目 MAJOR-B/C）。

      2 周目に「アラートへフォーカスを移す」修正とビューポート内判定を入れたが、それ自体が
      (a) 入力中の来訪者からフォーカスを奪う (b) 同値の再セットでは effect が走らず 2 回目は
      また画面外、という**2 つの欠陥を作った**。アラートと当該入力欄が同じビューポートに
      入らないのが根で、スクロール調整では解けない（情報設計の問題）。**#1018 で別に扱う。**

      したがってこの spec が主張するのは「**正しい文言が描かれること**」までである。
      「来訪者に見えること」は**まだ縛れていない** ―― PR の主張をここより強くしない。
    */
    // 確認画面へは進めない（進むと `summary` を読んで落ちる）。
    await expect(page.getByTestId('checkout-confirm')).toHaveCount(0);
  });

  /**
   * 🔴 **受付作成の `id` が欠けると、`undefined` が URL へ入る。**
   *
   * 直したかったのは `fetch('/api/kiosk/receptions/undefined/call')` である。この 1 本の
   * 主張が**本題**で、失敗画面が出ることだけを見ていると、`undefined` を URL へ入れたまま
   * サーバに弾かれて失敗画面が出る実装（＝直す前）でも通ってしまう。
   *
   * なお**サーバ側に残る孤児は防げない**（作成の POST は 200 を返しているので受付は存在し、
   * 端末はその ID を知らないので取り消せない）。ここで縛るのは「これ以上悪化させない」ことだけ。
   */
  test('受付: 作成応答の id が読めなければ、undefined を URL に入れない', async ({ page }) => {
    const called: string[] = [];
    // **観測を先に置く。** route より前に付けないと、最初の要求を取りこぼす。
    page.on('request', (req) => {
      if (req.url().includes('/api/kiosk/receptions')) called.push(`${req.method()} ${req.url()}`);
    });
    // 作成（POST /api/kiosk/receptions）だけを差し替える。`/call` などの子パスは通す。
    await page.route('**/api/kiosk/receptions', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: WRONG_SHAPE })
        : route.continue(),
    );

    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 一郎');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();

    // 呼び出しは成立しないので失敗画面へ倒れる（黙って calling に留まらせない）。
    await expect(page.getByTestId('result-failed')).toBeVisible();
    await expectNotCrashed(page);
    /*
      🔴 **理由の選択まで縛る**（独立レビュー 3 周目 MAJOR-E）。`server` を `network` へ戻す
      変異が生存していた ―― `shouldOfferAlternativeContact('network')` は false なので
      **失敗画面から代替導線が消える**（実測でボタンが 1 つ減る）。
      2 周目に「理由の選択まで縛る」を入れたとき、**同型 3 本のうちこの 1 本に入れ忘れて
      いた**（#788 の教訓と同型）。到達はしているので代表窓口の約束は果たせる。
    */
    await expect(page.getByTestId('use-fallback')).toBeVisible();

    /*
      🔴 **これが本題。** `undefined` / 空文字が URL に入っていないこと。
      `id` を検査しない実装ではここに `/api/kiosk/receptions/undefined/call` が現れる。
    */
    // **踏んだことの表明**（独立レビュー 1 周目 MINOR-2）。`called` が空だと下の 2 本は
    // 空虚に真になる。作成 POST が実際に飛んだことを先に主張する。
    expect(called.some((u) => u.startsWith('POST') && u.endsWith('/api/kiosk/receptions'))).toBe(true);
    expect(called.filter((u) => /\/receptions\/(undefined|null)\//.test(u))).toEqual([]);
    expect(called.filter((u) => /\/receptions\/\/+/.test(u))).toEqual([]);

    // 行き止まりにしない（逃げ道バーは常設）。
    await page.getByTestId('escape-reset').click();
    await expect(page.getByTestId('start-reception')).toBeVisible();
  });

  /**
   * 🔴 **呼び出し応答が読めないとき、代替導線まで消してはいけない**
   * （#1004、独立レビュー 1 周目 MAJOR-3）。
   *
   * 当初この経路は「下流が `unknown` 安全だから実害なし」と判定して**直さなかった**。
   * 誤りだった ―― 下流の前に **`res.json()` 自身が throw する**。`200 text/html` が返ると
   * 外側の catch が `CALL_FAILED reason: 'network'` を出し、
   * `shouldOfferAlternativeContact('network') === false` なので**画面からボタンが 1 つも
   * 無くなる**（レビューの実測: `PANEL_BUTTONS>>> []`）。
   *
   * 受付作成側（`server`）より**重い**経路が、判定漏れで放置されていた。到達はしているので
   * `server` へ倒し、「代表窓口へ」を残す。
   */
  test('受付: 呼び出し応答が読めなくても、代替導線を消さない', async ({ page }) => {
    const callCalls: string[] = [];
    page.on('request', (req) => {
      if (/\/api\/kiosk\/receptions\/[^/]+\/call/.test(req.url())) callCalls.push(req.method());
    });
    // 200 だが JSON ではない（企業プロキシが差し込むログイン画面などの形）。
    await page.route('**/api/kiosk/receptions/*/call', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy</html>' }),
    );

    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 一郎');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();

    // **踏んだことの表明。** これが無いと以降は空虚に真になりうる。
    await expect.poll(() => callCalls.length).toBeGreaterThan(0);

    await expect(page.getByTestId('result-failed')).toBeVisible();
    await expectNotCrashed(page);

    /*
      🔴 **これが本題。** `network` へ倒れると `use-fallback` が消える。
      到達はしているので代表窓口の約束は果たせる ―― 行き止まりにしない。
    */
    await expect(page.getByTestId('use-fallback')).toBeVisible();
  });
});
