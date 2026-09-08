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
    await expect(page.getByRole('heading', { name: '受付を続けられませんでした' })).toHaveCount(0);
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
