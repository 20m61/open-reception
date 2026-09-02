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
