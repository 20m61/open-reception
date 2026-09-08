import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * **読み取りが失敗したことが運用者に見える** (#870 増分 03 / 04)。
 *
 * 6 つの設定画面が `if (res.ok) setX(...)` に `else` を持たず、`if (!x) return <p>読み込み中…</p>`
 * で門を閉じていた。401 / 403 / 5xx / オフラインのとき、運用者は**終わらない待ち**に入る。
 * 何が起きたのかも、再試行の手段も画面に無い。
 *
 * 営業時間設定はさらに悪く、失敗しても「読めた」ことにしていたため
 * **「まだ設定がありません（未設定の間は常時営業として扱われます）」と断定表示**し、
 * その状態からの保存で**楽観ロックまで外れる**状態だった。
 *
 * ## 失敗を注入して見る
 *
 * ここは**実際に落として**確かめる唯一の層である。構造テスト
 * （`tests/config/admin-read-failure.test.ts`）は「機構が在る」ことしか言えない。
 * 500 と接続断の 2 通りを注入するのは、**握り潰しの経路が別**だから ——
 * 前者は `res.ok === false`、後者は `fetch` 自身が throw して `void load()` に飲まれる。
 * `catch` を書き忘れると後者だけが「読み込み中…」のまま固まり、前者しか見ていないと通る。
 */

/** 対象 API を 500 で落とす。 */
async function failWith500(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
  );
}

/** 対象 API への接続そのものを切る（オフライン相当。`fetch` が throw する）。 */
async function failWithAbort(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) => route.abort('failed'));
}

const SCREENS = [
  { path: '/admin/voice', api: '**/api/admin/voice', testId: 'voice-unavailable' },
  { path: '/admin/branding', api: '**/api/admin/branding', testId: 'branding-unavailable' },
  { path: '/admin/languages', api: '**/api/admin/languages', testId: 'languages-unavailable' },
  { path: '/admin/ai-guidance', api: '**/api/admin/ai-guidance', testId: 'ai-guidance-unavailable' },
  { path: '/admin/security', api: '**/api/admin/security', testId: 'security-unavailable' },
  {
    path: '/admin/integrations',
    api: '**/api/admin/integrations?*',
    testId: 'integrations-unavailable',
  },
] as const;

test.describe('管理: 読み取り失敗が運用者に見える (#870)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const screen of SCREENS) {
    test(`${screen.path}: 500 のとき「読み込み中…」で止まらず、再試行できる`, async ({ page }) => {
      await failWith500(page, screen.api);
      await page.goto(screen.path);

      const notice = page.getByTestId(screen.testId);
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('読み込めませんでした');
      // **終わらない待ちにしない。** 「読み込み中…」が残っていたらこの Issue の欠陥のまま。
      await expect(page.getByText('読み込み中…')).toHaveCount(0);
      // 理由だけでなく手段も出す（無いと運用者に残るのは画面リロードだけ）。
      await expect(page.getByTestId(`${screen.testId}-retry`)).toBeEnabled();
    });

    test(`${screen.path}: 接続断でも「読み込み中…」で止まらない`, async ({ page }) => {
      // `fetch` 自身が throw する経路。`catch` を書き忘れるとここだけ固まる。
      await failWithAbort(page, screen.api);
      await page.goto(screen.path);

      await expect(page.getByTestId(screen.testId)).toBeVisible();
      await expect(page.getByText('読み込み中…')).toHaveCount(0);
    });

    test(`${screen.path}: 再試行が回復すると本来の画面が出る`, async ({ page }) => {
      // **失敗表示で終わらせない。** 復帰できることまで見ないと、「失敗を出す」だけの
      // 実装（復帰不能）でも通ってしまう＝下界。
      await failWith500(page, screen.api);
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.testId)).toBeVisible();

      await page.unroute(screen.api);
      await page.getByTestId(`${screen.testId}-retry`).click();
      await expect(page.getByTestId(screen.testId)).toHaveCount(0);
    });
  }

  /**
   * 🔴 **形は正しい JSON だが、その画面の型ではない 200** (#1004)。
   *
   * `as SignageConfig` / `as { policy }` は実行時に何も検査しないので、企業プロキシや
   * API のバージョンスキューが返す `{"ok":true}` がそのまま state に入る。
   * 500 とは別の族なので、別に踏む。
   */
  const WRONG_SHAPE = '{"ok":true}';

  async function respondWrongShape(page: Page, pattern: string): Promise<void> {
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: WRONG_SHAPE }),
    );
  }

  /**
   * 🔴 **握り潰しの第 3 の経路**（独立レビュー 3 周目 MAJOR-2）。
   *
   * 本 spec は先頭で「500 と接続断の 2 通りを注入するのは、**握り潰しの経路が別**だから」と
   * 宣言している。#1004 は読み側に**第 3 の経路**を作った ―― ヘッダは読めるが**本文が
   * 途中で切れている 200**。`res.ok` は真、`fetch` も throw しないので、前 2 つでは踏めない。
   *
   * `.catch(() => null)` を落とすと `res.json()` の throw が `void load()` に飲まれ、
   * `setLoadedScopeKey` にも `setLoadFailed` にも到達しない ―― `gate.unavailable` は
   * `'loading'` になるので**再試行ボタンすら出ない**「読み込み中…」の恒久停止に戻る。
   * 書き込み側は `failWrites(..., 'broken-200')` で 7 画面すべて踏んでいたのに、
   * 読み側には対応する注入が無かった。
   */
  async function respondBrokenBody(page: Page, pattern: string): Promise<void> {
    // 途中で切れた JSON。`res.json()` が SyntaxError を投げる。
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"' }),
    );
  }

  test('営業時間: 本文が途中で切れた 200 も取得失敗として出す (#1004)', async ({ page }) => {
    await respondBrokenBody(page, '**/api/admin/operating-policy?*');
    await page.goto('/admin/operating-hours');

    await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();
    // 「読み込み中…」の恒久停止に戻さない（この spec が閉じた欠陥そのもの）。
    await expect(page.getByText('読み込み中…')).toHaveCount(0);
    await expect(page.getByTestId('operating-hours-unavailable-retry')).toBeEnabled();
    // 未設定と言い換えない・保存させない（500 のときと同じ下界）。
    await expect(page.getByText('まだ設定がありません')).toHaveCount(0);
    await expect(page.getByTestId('operating-hours-save')).toHaveCount(0);
  });

  test('サイネージ: 本文が途中で切れた 200 も取得失敗として出す (#1004)', async ({ page }) => {
    await respondBrokenBody(page, '**/api/admin/signage**');
    await page.goto('/admin/signage');

    await expect(page.getByTestId('signage-error')).toBeVisible();
    await expect(page.getByText('読み込み中…')).toHaveCount(0);
    /*
      🔴 **理由だけでなく手段も出す**（営業時間側 `:132` と同じ下界。独立レビュー 4 周目 MINOR-2）。
      これが無いと、`signage-retry` を**丸ごと削除する変異が e2e 112 本を素通りする**（実測）。
      落ちるのは構造テストのトークン検査だけで、振る舞い層は無防備だった。
    */
    await expect(page.getByTestId('signage-unavailable')).toBeVisible();
    await expect(page.getByTestId('signage-retry')).toBeEnabled();
    await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
  });

  /**
   * 🔴 **`await res.json()` を跨いでいる間に拠点が変わる** (#1004、独立レビュー 4 周目 MAJOR-1)。
   *
   * `#1004` は各画面に**新しい中断点**（`res.json()`）を作った。跨いだ後に画面へ書く行の前で
   * `isCurrentScope` を評価し直さないと、拠点 A の応答が拠点 B の画面へ載る。実測した症状は
   * **完全な沈黙**である —— B のセレクタのまま A の設定が表示され、`configScopeKey` が A に
   * なるので `dataLoaded` が偽 ⇒ **保存が恒久的に disabled**。`config` は非 null なので
   * 「読み込み中…」にもならず、メッセージも再試行導線も出ない。
   *
   * 🔴 **この窓は `route.fulfill` では作れないが、e2e で作れないわけではない。**
   * 3 周目の私の判定は「原理的に縛れない」だったが、**それは誤り**だった（4 周目レビューが
   * 実測で反証した）。`route` はヘッダと本文を分割配送できないだけで、`addInitScript` で
   * `Response.json()` の解決を保留すれば窓は決定的に作れる。同じ idiom が
   * `kiosk-calling-stage.spec.ts` / `kiosk-fallback.spec.ts` に既にある。
   */
  test('サイネージ: json を読んでいる間に拠点が変わったら、前の拠点の応答を載せない (#1004)', async ({
    page,
  }) => {
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    // 最初の GET だけ `json()` の解決を保留する。**goto より前**でないと既存 document に載らない。
    await page.addInitScript(() => {
      const w = window as unknown as { __release?: () => Promise<void>; __released?: boolean };
      const orig = window.fetch.bind(window);
      let held = false;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const req = args[0];
        const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
        const method = args[1]?.method ?? (req instanceof Request ? req.method : 'GET');
        const res = await orig(...args);
        if (!held && method === 'GET' && url.includes('/api/admin/signage')) {
          held = true;
          const origJson = res.json.bind(res);
          Object.defineProperty(res, 'json', {
            value: () =>
              new Promise((resolve) => {
                w.__release = async () => {
                  resolve(await origJson());
                  // **解放が実際に起きたことの正の観測点。** negative assertion の前に
                  // これを待たないと、CDP の往復が React のコミットより遅いことに
                  // 暗黙に依存する（独立レビュー 5 周目 残存リスク 1）。
                  w.__released = true;
                };
              }),
          });
        }
        return res;
      };
    });

    await page.goto('/admin/signage');
    // この時点では 1 本目はまだ**応答すらしていない**（「読み込み中…」が見えるのは単に
    // 初回レンダーだから）。窓が開いたことは下の `__release` の定義で確かめる。
    await expect(page.getByText('読み込み中…')).toBeVisible();

    // 別拠点へ切り替える。2 本目は保留していないので普通に載る。
    await page.getByTestId('signage-site-select').selectOption('branch-site');
    await expect(page.getByTestId('signage-save')).toBeEnabled();

    /*
      🔴 **窓が開いたことを主張してから解放する。**

      これが無いと、この spec は**欠陥入りビルドでも緑になる**（独立レビュー 5 周目 MAJOR-1 が
      実測で示した）。前の拠点の応答が遅れて `res.json()` の手前の門で早期 return すると、
      `__release` は未定義のまま ―― `?.()` は無言で no-op し、下の 4 本は全部通る。
      窓が開くかどうかは応答順の競争なので、**開いたことを表明しない限りこの spec は
      何も測っていない**。`?.()` にしないのも同じ理由（静かな緑を大声の赤にする）。
    */
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __release?: unknown }).__release !== undefined))
      .toBe(true);

    // 前の拠点の設定が載れば必ず上書きされる値を置いておく（`setConfig` の副作用は
    // `dataLoaded` とは独立なので、下の 4 本だけでは**内容の越境**を主張できない
    // ―― 5 周目 MINOR-2）。seed の差に頼らず、自分で目印を作る。
    await page.getByTestId('signage-interval').fill('37');

    await page.evaluate(() => (window as unknown as { __release: () => Promise<void> }).__release());
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __released?: boolean }).__released === true))
      .toBe(true);

    /*
      **これが本題。** 前の拠点の応答を載せないので、画面は何も変わらない。
      門を外すと `setConfigScopeKey(前の拠点)` が走って `dataLoaded` が偽になり
      **保存ボタンが恒久的に disabled**、同時に `setConfig(前の拠点)` がフォームを
      上書きする（実測した変異の症状）。
    */
    await expect(page.getByTestId('signage-interval')).toHaveValue('37');
    await expect(page.getByTestId('signage-site-select')).toHaveValue('branch-site');
    await expect(page.getByTestId('signage-save')).toBeEnabled();
    await expect(page.getByTestId('signage-error')).toHaveCount(0);
    await expect(page.getByTestId('signage-unavailable')).toHaveCount(0);
  });

  test('サイネージ: 形の違う 200 を読んでも画面が落ちない (#1004)', async ({ page }) => {
    await respondWrongShape(page, '**/api/admin/signage**');
    await page.goto('/admin/signage');

    // 読めなかったことを言う（黙って空の画面にしない）。
    await expect(page.getByTestId('signage-error')).toBeVisible();
    // 🔴 **落ちていないことを直接見る。** 描画例外は root の `global-error.tsx` が受け、
    // 管理者に**来訪者向けの文言**が出る（`pageerror` は発火しないので、それをオラクルに
    // すると空虚になる ―― 独立レビュー MINOR-1 の指摘を実測で確かめた）。
    await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
  });

  /**
   * 🔴 **load 側にも検査が要る** (#1004)。`policy` キーが欠けた 200 で
   * `applyPolicy(undefined)` が走ると、フォームが黙って既定値へ初期化され、
   * `expectedVersion` が落ちて **#367 の楽観ロックが外れる**。
   */
  test('営業時間: 形の違う 200 を読んだら取得失敗として出す (#1004)', async ({ page }) => {
    await respondWrongShape(page, '**/api/admin/operating-policy?*');
    await page.goto('/admin/operating-hours');

    await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();
    // 「未設定」と言い換えない（500 のときと同じ下界）。
    await expect(page.getByText('まだ設定がありません')).toHaveCount(0);
    // 保存ボタンごと出さない＝`expectedVersion` を落とした PUT を飛ばさせない。
    await expect(page.getByTestId('operating-hours-save')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
  });

  /**
   * 🔴 **一度読めた後の取得失敗が黙らない** (#1004)。`loadFailed` を描くのは
   * `resolveScopeGate` 経由の差し替え枝だけで、そこは `dataLoaded` が真になると通らない。
   * つまり 409 の復旧導線「最新を読み込む」を押して失敗しても**バナーが消えるだけ**で、
   * 運用者は最新を掴んだと信じて保存し、また 409 になる。
   */
  test('営業時間: 409 からの「最新を読み込む」が失敗したら、そう言う (#1004)', async ({ page }) => {
    await page.goto('/admin/operating-hours');
    await expect(page.getByTestId('operating-hours-save')).toBeVisible();

    // 保存を 409 にして復旧導線を出す。GET は通したままにする（拠点は変えない）。
    await page.route('**/api/admin/operating-policy**', (route) => {
      if (route.request().method() === 'GET') return route.continue();
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: '{"error":"conflict"}',
      });
    });
    await page.getByTestId('operating-hours-save').click();
    await expect(page.getByTestId('operating-hours-conflict')).toBeVisible();

    // ここから GET も壊す。**同じ拠点のまま**押すので `loadedScopeKey` は落ちない
    // ＝差し替え枝（再試行ボタン付き）には入らない経路である。
    await respondWrongShape(page, '**/api/admin/operating-policy?*');
    await page.getByTestId('operating-hours-reload').click();

    // **これが本題。** 掴み直せなかったことを黙らない（バナーだけ消して終わらせない）。
    const error = page.getByTestId('operating-hours-reload-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');

    /*
      🔴 **理由だけでなく手段も出す**（独立レビュー 2 周目 MAJOR-A）。この枝へ来る経路は
      事実上「409 →『最新を読み込む』→失敗」の 1 本だけで、押した瞬間にその
      「最新を読み込む」ボタン自身が unmount する。導線が無いと、運用者に残るのは
      (1) また 409 になると分かっている保存を押して 409 の箱を呼び戻す
      (2) 編集中の内容を捨ててページごとリロード、の 2 つしかない。
      この spec が他 6 画面へ `:65` で機械要求しているのと同じ規約である。
    */
    const retry = page.getByTestId('operating-hours-reload-error-retry');
    await expect(retry).toBeEnabled();

    /*
      **失敗表示で終わらせない（下界）。** 復帰できることまで見ないと、「失敗を出すだけ・
      復帰不能」な実装でも通ってしまう。`unroute` すると GET は先に登録した 409 ハンドラの
      `route.continue()` へ落ちる（PUT だけが 409 のまま）。
    */
    await page.unroute('**/api/admin/operating-policy?*');
    await retry.click();
    await expect(error).toHaveCount(0);
    await expect(page.getByTestId('operating-hours-save')).toBeVisible();
  });

  /**
   * 🔴 **保存が成功したら、取得失敗のバナーは嘘になる** (#1004)。
   *
   * 保存の応答はサーバの確定値そのもので、`applyPolicy(saved.policy)` がフォームへ載せる。
   * それでも「画面の内容は古い可能性があります」を `role="alert"` で出し続けると、
   * 運用者は保存できたのか分からない。
   *
   * この 1 本が無いと `setLoadFailed(false)` を消す変異が e2e 111 本を素通りする（実測）。
   * バナーを出す枝（409 →「最新を読み込む」→失敗）を通ってからでないと測れないので、
   * 上のテストと同じ前置きが要る。
   */
  test('営業時間: 保存に成功したら取得失敗のバナーが消える (#1004)', async ({ page }) => {
    const LOADED = JSON.stringify({
      policy: {
        tenantId: 'internal',
        siteId: 'default-site',
        timezone: 'Asia/Tokyo',
        weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
        fixedHolidays: [],
        exceptionDates: [],
        version: 4,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: 'admin',
      },
    });

    await page.goto('/admin/operating-hours');
    await expect(page.getByTestId('operating-hours-save')).toBeVisible();

    // 409 で復旧導線を出す（GET は通す）。
    await page.route('**/api/admin/operating-policy**', (route) => {
      if (route.request().method() === 'GET') return route.continue();
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"conflict"}' });
    });
    await page.getByTestId('operating-hours-save').click();
    await expect(page.getByTestId('operating-hours-conflict')).toBeVisible();

    // GET を壊して「最新を読み込む」を失敗させ、バナーを立てる。
    await respondWrongShape(page, '**/api/admin/operating-policy?*');
    await page.getByTestId('operating-hours-reload').click();
    const error = page.getByTestId('operating-hours-reload-error');
    await expect(error).toBeVisible();

    // **GET は壊したまま**、保存だけ成功させる。バナーを消すのが load ではなく保存の応答で
    // あることを、これで固定する（GET を直すと、どちらが消したのか区別できない）。
    await page.unroute('**/api/admin/operating-policy**');
    await respondWrongShape(page, '**/api/admin/operating-policy?*');
    await page.route('**/api/admin/operating-policy', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: LOADED })
        : route.continue(),
    );
    await page.getByTestId('operating-hours-save').click();

    await expect(page.getByTestId('operating-hours-saved')).toBeVisible();
    // **これが本題。** 確定値を載せたのに「古い可能性があります」を出し続けない。
    await expect(error).toHaveCount(0);
  });

  test('営業時間: 取得に失敗したとき「未設定＝常時営業」と断定しない', async ({ page }) => {
    await failWith500(page, '**/api/admin/operating-policy?*');
    await page.goto('/admin/operating-hours');

    await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();
    // **これがこの増分の肝。** 取得できていないことを、設定が無いことと言い換えない。
    await expect(page.getByText('まだ設定がありません')).toHaveCount(0);
    await expect(page.getByText('読み込み中…')).toHaveCount(0);
  });

  test('営業時間: 取得に失敗した状態からは保存させない（楽観ロックを外さない）', async ({ page }) => {
    await failWith500(page, '**/api/admin/operating-policy?*');
    await page.goto('/admin/operating-hours');
    await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();

    // 保存ボタンごと出さない。押せる状態で残すと、`expectedVersion` を落とした PUT が飛び、
    // 他の管理者の更新を黙って上書きできてしまう。
    await expect(page.getByTestId('operating-hours-save')).toHaveCount(0);
  });

  test('営業時間: 再試行が回復すると編集できる（下界）', async ({ page }) => {
    await failWith500(page, '**/api/admin/operating-policy?*');
    await page.goto('/admin/operating-hours');
    await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();

    await page.unroute('**/api/admin/operating-policy?*');
    await page.getByTestId('operating-hours-unavailable-retry').click();
    await expect(page.getByTestId('operating-hours-save')).toBeVisible();
  });
});
