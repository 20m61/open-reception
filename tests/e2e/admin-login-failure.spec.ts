import { test, expect, type Page } from '@playwright/test';

/**
 * 管理ログインの**失敗が運用者に正しく届く** (#973 / #1021)。
 *
 * ## なぜ e2e でしか縛れないか
 *
 * このリポジトリの component テストは `renderToStaticMarkup` なので、送信の相互作用
 * （`fetch` の応答 → `setFailure` → 画面）を踏めない。unit 側は
 * `login-outcome.test.ts` がソース文字列を grep しているだけで、**分岐条件そのもの**
 * （`if (res.ok)`）を変異させる族に無力である —— 実測で
 * `if (res.ok || res.status >= 500)` が **unit 1525 本を素通りした**（2026-09-16）。
 *
 * その世界では、`ADMIN_PASSWORD` 未設定のデプロイで運用者は 500 を受けても `/admin` へ
 * 進み、middleware に跳ね返され、**画面にも読み上げにも何も出ない**。#973 が塞いだ
 * 「押しても何も起きない」そのものである。
 *
 * ここで縛る不変条件は 2 つ:
 *
 * 1. **「パスワードが正しくありません」と出してよいのは 401 のときだけ**（#1021）
 * 2. **失敗したら必ず何かが出て、ログイン画面に留まる**（#973）
 */

/** `AdminPasswordLogin` の応答を差し替えて送信する。 */
async function submitWithStubbedLogin(page: Page, status: number, body: string): Promise<void> {
  await page.route('**/api/admin/login', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({ status, contentType: 'application/json', body });
  });
  await page.goto('/admin/login');
  await page.getByTestId('admin-password').fill('whatever');
  await page.getByTestId('admin-login-submit').click();
}

/**
 * 🔴 **フォーム内へ絞る。** `data-testid="admin-login-error"` は同じページに **2 つ**ある
 * （`src/app/admin/login/page.tsx` の Entra `?error=` 表示と `AdminPasswordLogin` の alert）。
 * `getByTestId` のままだと、`?error=` 付きの遷移を足した瞬間に strict mode violation で
 * 落ちる —— テストが実装の都合（今は `?error=` を踏まない）に寄りかかることになる。
 */
const alertOf = (page: Page) => page.locator('form [data-testid="admin-login-error"]');

test('🔴 サーバが 500 を返したら「パスワードが正しくありません」と言わない', async ({ page }) => {
  await submitWithStubbedLogin(page, 500, '{"error":"server_error"}');

  const alert = alertOf(page);
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  // 🔴 本体。サーバはパスワードを見ていないのだから、正否を断定してはいけない。
  await expect(alert).not.toContainText('パスワードが正しくありません');
  await expect(alert).toContainText('確認されていません');
  // 未認証で見える画面なので、どの設定が欠けているかは出さない。
  await expect(alert).not.toContainText('ADMIN_PASSWORD');
  // 失敗したのに先へ進まない（#973 の「押しても何も起きない」を再発させない）。
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('🔴 サーバが 401 を返したらパスワードの誤りとして伝える（下界）', async ({ page }) => {
  // これが無いと、上の主張は**全部を server_error にする**世界でも満たせてしまう。
  await submitWithStubbedLogin(page, 401, '{"error":"unauthorized"}');

  const alert = alertOf(page);
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('パスワードが正しくありません');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('🔴 応答が返らないときは通信の問題として伝える（原因を断定しない）', async ({ page }) => {
  await page.route('**/api/admin/login', (route) => route.abort('failed'));
  await page.goto('/admin/login');
  await page.getByTestId('admin-password').fill('whatever');
  await page.getByTestId('admin-login-submit').click();

  const alert = alertOf(page);
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('パスワード');
  await expect(alert).toContainText('接続できませんでした');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

/**
 * 🔴 **上界。** ここまでの 3 本は「失敗したら留まる」しか言っていないので、
 * **何をしても進まない**世界でも満たせる。成功時に実際に `/admin` へ進むことまで見る。
 *
 * ここだけは応答を差し替えない —— 差し替えた 200 はセッション cookie を持たないので
 * middleware に `/admin/login` へ跳ね返され、**成功していないのに成功に見える**
 * （実際に一度これで緑になりかけた）。**本物のパスワードでフォームを送る。**
 * `loginAsAdmin` ヘルパは API を直接叩くので、フォームの成功経路はここでしか踏まれない。
 */
test('🔴 成功したら /admin へ進む（上界）', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByTestId('admin-password').fill('open-reception');
  await page.getByTestId('admin-login-submit').click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(alertOf(page)).toHaveCount(0);
});
