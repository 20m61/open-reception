import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * **platform の通信失敗が運用者に見える** (#968)。
 *
 * ## なぜ静的検査だけでは足りなかったか
 *
 * #968 は当初 `tests/config/platform-fetch-failure.test.ts` の**字句走査**だけで縛っていた。
 * 独立レビューが 3 周にわたって当てた変異のうち **12 件が生存**し、そのたびに検出器へ
 * 綴りを 1 つ足す、を繰り返した（`method: "PATCH"` → `method: PATCH_METHOD`、
 * `!res.ok` → `const { ok } = res` → `res.ok !== true`、`{cond ? …}` → `{cond && …}`、
 * import の引用符、…）。`.claude/rules/opus5-autonomous-loop.md`「値を調整している自分には
 * 気づけない」がそのまま当たっており、**方式が収束していなかった**。
 *
 * 前提を替える。このリポジトリは #870 で**同じ欠陥族に対する正しい方式を既に持っている**
 * —— `tests/e2e/admin-read-failure.spec.ts` は「実際に落として見る」。#968 はそれを使わずに
 * 走査を再発明していた。ここが**族としての担保**で、字句走査は速い一次検査として残す。
 *
 * ## 何を注入するか
 *
 * 500 / 403 / 接続断の 3 通り。**握り潰しの経路が別**だから:
 *
 *  - 500・403 … `res.ok === false`。この console で最も起こりやすいのは **403**
 *    （developer 権限・昇格切れ）で、オフラインより遥かに多い
 *  - 接続断 … `fetch` 自身が throw して `void load()` に飲まれる
 *
 * `catch` を書き忘れると接続断だけが固まり、`!res.ok` の枝を書き忘れると 403 だけが黙る。
 * **どちらか一方しか見ないと、もう一方が無検出で通る。**
 */

/** 対象 API を 500 で落とす。 */
async function failWith500(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
  );
}

/** 対象 API を 403 で落とす（昇格切れ・権限不足の相当）。 */
async function failWith403(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }),
  );
}

/** 対象 API への接続そのものを切る（オフライン相当。`fetch` が throw する）。 */
async function failWithAbort(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) => route.abort('failed'));
}

/**
 * 読み取りの失敗が「無言」にならない画面。
 *
 * `testId` は**その画面の失敗表示**を指す。`role="alert"` を持つことは
 * `tests/config/platform-list-states.test.ts` が別に縛るので、ここは
 * **出ること**と**永遠の待ちにならないこと**を見る。
 */
const READS = [
  {
    label: '運用ダッシュボード',
    path: '/platform',
    api: '**/api/platform/dashboard',
    testId: 'platform-dashboard-error',
    forbiddenText: '閲覧権限',
  },
  {
    label: 'プロバイダ設定',
    path: '/platform/integrations',
    api: '**/api/platform/integrations/provider-config',
    testId: 'provider-config-load-error',
    forbiddenText: '権限',
  },
  {
    label: '機能フラグ（横断サマリ）',
    path: '/platform/feature-flags',
    api: '**/api/platform/feature-flags',
    testId: 'platform-feature-flags-error',
    forbiddenText: '閲覧権限',
  },
] as const;

/** 形の壊れた 200。**「0 件」ではなく「読めなかった」**として扱われることを見る。 */
async function fulfillEmptyBody(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
}

test.describe('platform: 読み取りの失敗が運用者に見える (#968)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const screen of READS) {
    test(`${screen.label}: 500 のとき失敗が出る`, async ({ page }) => {
      await failWith500(page, screen.api);
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.testId)).toBeVisible();
    });

    test(`${screen.label}: 403（昇格切れ）のとき失敗が出る`, async ({ page }) => {
      await failWith403(page, screen.api);
      await page.goto(screen.path);
      const alert = page.getByTestId(screen.testId);
      await expect(alert).toBeVisible();
      /*
       * 🔴 **原因を言い分ける (#968 レビュー 5 周目 MAJOR-4)。** 403（昇格切れ）と
       * 500（障害）とでは運用者の次の行動が違う。文言まで縛らないと、分岐を定数へ
       * 潰す変異が素通りする（実測で 4 箇所とも生存した）。
       */
      await expect(alert).toContainText(screen.forbiddenText);
    });

    /*
     * 🔴 **形の壊れた 200 も「読めなかった」(#968 レビュー 5 周目 MAJOR-1 / MAJOR-2)。**
     *
     * 放置すると render で投げ、`global-error.tsx` が**来訪者向けの文言**
     * 「受付を続けられませんでした」を運用コンソールに出す。`?? []` で埋めるのも駄目で、
     * それは大声の失敗を沈黙の誤動作へ変換するだけ（「テナントが 1 つも無い」と同じ
     * 見た目になる）。**失敗として報告する**のが正しい。
     */
    test(`${screen.label}: 形の壊れた 200 を「0 件」にせず失敗として出す`, async ({ page }) => {
      await fulfillEmptyBody(page, screen.api);
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.testId)).toBeVisible();
      // 来訪者向けのエラー境界へ落ちていない。
      await expect(page.getByText('受付を続けられませんでした')).toHaveCount(0);
    });

    test(`${screen.label}: 接続断でも失敗が出る（reject を void に捨てない）`, async ({ page }) => {
      await failWithAbort(page, screen.api);
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.testId)).toBeVisible();
    });
  }

  /*
   * 🔴 **テナント一覧はヘッダの切替そのもの。** 取れないと選択肢が空のまま
   * 「全テナント横断」だけが残り、**テナントが 1 つも無いのと同じ見た目**になる。
   * 403 は昇格切れで日常的に起こる。
   */
  test('ヘッダのテナント切替: 403 のとき「テナントが無い」と見せない', async ({ page }) => {
    await failWith403(page, '**/api/platform/tenants');
    await page.goto('/platform');
    const alert = page.getByTestId('platform-tenant-list-error');
    await expect(alert).toBeVisible();
    // 🔴 403 を 500 と同じ文言に潰す変異を落とす（原因が違えば運用者の次の行動も違う）。
    await expect(alert).toContainText('権限');
  });

  test('ヘッダのテナント切替: 接続断でも黙らない', async ({ page }) => {
    await failWithAbort(page, '**/api/platform/tenants');
    await page.goto('/platform');
    await expect(page.getByTestId('platform-tenant-list-error')).toBeVisible();
  });

  /*
   * 🔴 **いちばん広く塞ぐところの復帰導線 (#968 レビュー 5 周目 MAJOR-6)。**
   * ここが引けないと、他画面の「画面上部の切替で選んでください」の**指示先が死ぬ**。
   */
  test('ヘッダのテナント切替: 再試行で選択肢が実際に戻る', async ({ page }) => {
    await failWith403(page, '**/api/platform/tenants');
    await page.goto('/platform');
    await expect(page.getByTestId('platform-tenant-list-error')).toBeVisible();

    const select = page.getByTestId('platform-tenant-switcher');
    await expect(select.locator('option')).toHaveCount(1);

    await page.unroute('**/api/platform/tenants');
    await page.getByTestId('platform-tenant-list-retry').click();

    await expect(page.getByTestId('platform-tenant-list-error')).toHaveCount(0);
    await expect(select.locator('option')).not.toHaveCount(1);
  });

  /*
   * 🔴 **書込中は切替させない（B-1 のレース窓を閉じた guard の証拠）。**
   * 外す変異は unit・e2e とも素通りしていた（レビュー 5 周目 MINOR-1）。
   */
  test('機能フラグ: 昇格つき書込の最中はテナントを切り替えさせない', async ({ page }) => {
    await page.goto('/platform/feature-flags');
    const select = page.getByTestId('tenant-feature-flag-editor').locator('select');
    const first = await select.locator('option').nth(1).getAttribute('value');
    expect(first, 'seed にテナントが無い').toBeTruthy();
    await select.selectOption(first ?? '');

    // PATCH を宙吊りにして「書込中」を作る。
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/platform/tenants/*/feature-flags', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await held;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });

    await page.getByRole('textbox').last().fill('e2e: 切替禁止の確認');
    await page.getByRole('button', { name: /昇格つきで(有効|無効)化/ }).first().click();

    await expect(select).toBeDisabled();
    release?.();
    await expect(select).toBeEnabled();
  });

  /*
   * 🔴 **テナント一覧の shape 破れも「0 件」にしない (#968 レビュー 5 周目 MAJOR-2)。**
   * `?? []` で埋める修正は**大声の失敗を沈黙の誤動作へ変換する**だけで、選択肢が空のまま
   * 「テナントが 1 つも無い」のと同じ見た目になる（このファイル自身がそれを禁じている）。
   */
  test('機能フラグ: テナント一覧の形が壊れていても「0 件」にしない', async ({ page }) => {
    await fulfillEmptyBody(page, '**/api/platform/tenants');
    await page.goto('/platform/feature-flags');
    await expect(page.getByTestId('platform-feature-flags-tenants-error')).toBeVisible();
    await expect(page.getByTestId('platform-tenant-list-error')).toBeVisible();
  });

  /*
   * 🔴 **機能フラグはテナントを選べないと編集そのものが不能になる。**
   * 狭いほう（フラグの取得失敗）にだけ再試行があり、広いほう（一覧が引けない）に
   * 無い、という逆転を作っていた（レビュー MJ-1）。復帰導線まで見る。
   */
  test('機能フラグ: テナント一覧が 403 のとき、失敗と再試行が出る', async ({ page }) => {
    await failWith403(page, '**/api/platform/tenants');
    await page.goto('/platform/feature-flags');
    await expect(page.getByTestId('platform-feature-flags-tenants-error')).toBeVisible();
    await expect(page.getByTestId('feature-flags-tenants-retry')).toBeEnabled();
  });

  /*
   * 🔴 **テナントを選んだあとの取得失敗**。ここは `flags` が `null` のときにしか立たない
   * state なので、描画を `{flags && …}` の内側へ移すと**永遠に到達しない**（レビューが
   * 実測で生存させた形）。字句走査では「描いている」と読めてしまうので、実際に落として見る。
   */
  test('機能フラグ: テナントを選んだあとの取得失敗が出る', async ({ page }) => {
    await page.goto('/platform/feature-flags');
    const select = page.getByTestId('tenant-feature-flag-editor').locator('select');
    await expect(select).toBeVisible();
    const first = await select.locator('option').nth(1).getAttribute('value');
    expect(first, 'seed にテナントが無い').toBeTruthy();

    await failWith500(page, '**/api/platform/tenants/*/feature-flags');
    await select.selectOption(first ?? '');

    await expect(page.getByTestId('platform-feature-flags-flags-error')).toBeVisible();
    // 終わらない待ちにしない。
    await expect(page.getByText('読み込み中…')).toHaveCount(0);
    await expect(page.getByTestId('feature-flags-retry')).toBeEnabled();
  });

  /*
   * 🔴 **失敗表示で終わらせない。** 復帰できることまで見ないと、「失敗を出す」だけの
   * 実装（復帰不能）でも通る＝下界。**ボタンの `onClick` を殺す変異はここでだけ落ちる**
   * （字句走査は「ボタンが在る」しか言えない。レビューが実測で生存させた形）。
   */
  /*
   * 🔴 **「消えたこと」で復帰を縛らない (#968 レビュー 4 周目 MAJOR-1)。**
   *
   * `onClick` の先頭で `setTenantsError(null)` を撃つので、**失敗表示が消えることは
   * 同期の 1 行だけで満たせる** —— 実測で「再試行は何もしない」変異が e2e・unit とも
   * 素通りした。取得**結果が画面に反映されたこと**を縛る。
   */
  test('機能フラグ: 再試行でテナント一覧が実際に戻る', async ({ page }) => {
    await failWith403(page, '**/api/platform/tenants');
    await page.goto('/platform/feature-flags');
    await expect(page.getByTestId('platform-feature-flags-tenants-error')).toBeVisible();

    const select = page.getByTestId('tenant-feature-flag-editor').locator('select');
    // 失敗中は「選択してください」だけ。
    await expect(select.locator('option')).toHaveCount(1);

    await page.unroute('**/api/platform/tenants');
    await page.getByTestId('feature-flags-tenants-retry').click();

    await expect(page.getByTestId('platform-feature-flags-tenants-error')).toHaveCount(0);
    // **復帰の実体**: 選択肢が戻る（seed のテナントぶん増える）。
    await expect(select.locator('option')).not.toHaveCount(1);
  });

  /*
   * 🔴 **`feature-flags-retry` は押されていなかった** —— `toBeEnabled()` だけでは
   * 「死んだボタン」を通す（レビュー 4 周目 MAJOR-1）。押して、フラグが戻ることまで見る。
   */
  test('機能フラグ: フラグの再試行でトグルが戻る', async ({ page }) => {
    await page.goto('/platform/feature-flags');
    const select = page.getByTestId('tenant-feature-flag-editor').locator('select');
    await expect(select).toBeVisible();
    const first = await select.locator('option').nth(1).getAttribute('value');
    expect(first, 'seed にテナントが無い').toBeTruthy();

    await failWith500(page, '**/api/platform/tenants/*/feature-flags');
    await select.selectOption(first ?? '');
    await expect(page.getByTestId('platform-feature-flags-flags-error')).toBeVisible();

    await page.unroute('**/api/platform/tenants/*/feature-flags');
    await page.getByTestId('feature-flags-retry').click();

    await expect(page.getByTestId('platform-feature-flags-flags-error')).toHaveCount(0);
    // **復帰の実体**: 昇格つきトグルが戻る。
    await expect(page.getByRole('button', { name: /昇格つきで(有効|無効)化/ }).first()).toBeVisible();
  });

  /*
   * 🔴 **「再読込」が実際に読み直すことを見る。**
   *
   * 失敗表示が消えることでは縛れない —— この画面は**テナント未選択のとき 400 を返す**ので、
   * 復旧させても別の理由（「対象テナントを選択してください。」）で失敗表示が残る。
   * 縛りたいのは「ボタンが本当に再取得を撃つか」なので、**リクエストそのものを観測**する。
   * `onClick` を `() => undefined` にする変異（レビューが実測で生存させた形）はここで落ちる。
   */
  test('プロバイダ設定: 再読込が実際に読み直す（死んだボタンにしない）', async ({ page }) => {
    await failWith500(page, '**/api/platform/integrations/provider-config');
    await page.goto('/platform/integrations');
    await expect(page.getByTestId('provider-config-load-error')).toBeVisible();

    const reread = page.waitForRequest(
      (request) =>
        request.url().includes('/api/platform/integrations/provider-config') &&
        request.method() === 'GET',
      { timeout: 5_000 },
    );
    await page.getByTestId('provider-config-reload').click();
    await expect(reread).resolves.toBeTruthy();
  });

  /*
   * 🔴 **読めていない状態から全置換 upsert を撃たせない (#968 レビュー M2)。**
   *
   * `PUT /api/platform/integrations/provider-config` は楽観ロックの無い全置換 upsert で、
   * 読めていない画面の初期値（`mock` / 無効 / 空）で保存すると**実 CCaaS 設定が既定値で
   * 上書きされる** —— 来訪者側は担当者を呼べず「取り次げません」になる。
   */
  test('プロバイダ設定: 読めていないとき保存系は押せず、「未設定」と断定しない', async ({ page }) => {
    await failWith500(page, '**/api/platform/integrations/provider-config');
    await page.goto('/platform/integrations');
    await expect(page.getByTestId('provider-config-load-error')).toBeVisible();

    await expect(page.getByRole('button', { name: '設定を保存' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'secret を保存' })).toBeDisabled();
    /*
     * 🔴 **両側から縛る (#968 レビュー 5 周目 MAJOR-5)。**
     * 「未設定と断定しない」だけだと、失敗を**読み込み中**と断定する変異が素通りする
     * （`#870` が閉じた「失敗が永遠の読み込み中に化ける」へ戻る）。`不変条件は片側しか
     * 主張しない。下界を併せて縛る`（`.claude/rules/opus5-autonomous-loop.md`）。
     */
    const section = page.locator('section', { has: page.getByTestId('provider-config-load-error') });
    await expect(section.getByText('未設定', { exact: true })).toHaveCount(0);
    await expect(section.getByText('読み込み中…')).toHaveCount(0);
    await expect(section.getByText('取得できていません')).toBeVisible();
  });

  /*
   * 🔴 **`detail` の無い 200 を「読めた」にしない (#968 レビュー 5 周目 MAJOR-3)。**
   *
   * `setData(undefined)` すると `loaded={data !== null}` が**真**になり、画面は
   * 「このテナントに拠点がありません。」と**断定**する。実在する拠点/端末を「無い」と
   * 読ませる形で、#870 の営業時間設定（取得できていないことを「未設定」と言い換える）と同型。
   */
  test('テナント詳細: 形の壊れた 200 を「拠点が無い」と断定しない', async ({ page }) => {
    await page.goto('/platform/tenants');
    const detail = page.locator('a[href^="/platform/tenants/"]').first();
    await expect(detail).toBeVisible();
    const href = await detail.getAttribute('href');

    await fulfillEmptyBody(page, '**/api/platform/tenants/*');
    await page.goto(href ?? '/platform/tenants');

    await expect(page.getByTestId('platform-tenant-detail-error')).toBeVisible();
    await expect(page.getByText('このテナントに拠点がありません。')).toHaveCount(0);
  });

  /*
   * 🔴 **破壊的操作が無言で失敗しない (#968 AC1)。**
   *
   * テナントの停止/有効化は `try`/`finally` だけで囲われており、`fetch` の reject は
   * `void` に捨てられて **`busy` が戻るだけ**だった。押した運用者は「何も起きなかった」と
   * 読み、もう一度押すか、停止できたと誤解する。
   */
  test('テナント詳細: 停止の送信が失敗したら、失敗したと出る', async ({ page }) => {
    await page.goto('/platform/tenants');
    const detail = page.locator('a[href^="/platform/tenants/"]').first();
    await expect(detail).toBeVisible();
    await detail.click();
    await expect(page.getByTestId('platform-tenant-sites')).toBeVisible();

    // 読み取り（GET）は通したまま、**操作（PATCH）だけ**を落とす。
    await page.route('**/api/platform/tenants/*', async (route) => {
      if (route.request().method() === 'PATCH') return route.abort('failed');
      return route.continue();
    });

    // DangerActionButton の確認フロー（影響範囲 ack + 理由入力 + 二段確認）を通す。
    await page.getByTestId('danger-open').click();
    await page.getByTestId('danger-impact').check();
    await page.getByTestId('danger-reason').fill('e2e: 通信失敗の確認');
    await page.getByTestId('danger-confirm').click();

    const actionError = page.getByTestId('platform-tenant-action-error');
    await expect(actionError).toBeVisible();
    /*
     * 🔴 **操作の失敗が読み取りを汚さない (#968 AC4)。** 同じ `error` に載せていたので、
     * 停止に失敗しただけでサイト一覧が「読み込めませんでした。」へ落ちていた ——
     * 読めているのに読めていないと言うことになる。
     *
     * 🔴 **`platform-tenant-sites-failed` の不在では縛れない**（レビュー 4 周目 MAJOR-2）——
     * `DataTable` は `rows.length === 0` の枝でしか失敗を描かないので、サイトを持つ
     * テナントでは**原理的に出ない**。行数に依らない**読み取りの失敗表示**で縛る。
     */
    await expect(page.getByTestId('platform-tenant-detail-error')).toHaveCount(0);
    await expect(page.getByTestId('platform-tenant-sites')).toBeVisible();
  });
});
