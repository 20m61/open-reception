import { test, expect } from '@playwright/test';
import { establishKioskSession, loginAsAdmin } from './helpers';

/**
 * 管理画面の認可境界 E2E (issue #24)。
 * 未認証では管理画面/APIにアクセスできず、ログイン後にアクセスできることを確認する。
 */

test('未認証では /admin がログインへリダイレクトされる', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByTestId('admin-login-submit')).toBeVisible();
});

test('未認証の管理 API は 401 を返す', async ({ page }) => {
  const res = await page.request.get('/api/admin/receptions');
  expect(res.status()).toBe(401);
});

test('誤ったパスワードのログインは拒否される', async ({ page }) => {
  const res = await page.request.post('/api/admin/login', { data: { password: 'wrong' } });
  expect(res.status()).toBe(401);
});

test('ログイン後は管理画面と管理 API にアクセスできる', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

  const res = await page.request.get('/api/admin/receptions');
  expect(res.ok()).toBeTruthy();
});

/**
 * このテストは元々「kiosk API は認証なしで利用できる（公開）」だった (#24)。当時の意図は
 * **admin 認証の背後に置かない**こと（端末は管理者ではない）で、「誰でも読める」を意図した
 * ものではなかった。その後 #239 で kiosk セッションゲートが入り、ほとんどの kiosk API が
 * セッション必須になったが `directory` だけ取り残されていた (#589)。
 *
 * 現在の意図を書き直す: **admin 認証は要らないが、kiosk セッションは要る。**
 */
test('kiosk API は admin 認証を要さないが、kiosk セッションは要る', async ({ page }) => {
  // 管理者としてログインしていない状態でも、admin ログインへは飛ばされない（admin 境界の外）。
  const anonymous = await page.request.get('/api/kiosk/directory');
  expect(anonymous.status()).toBe(403);
  const body = (await anonymous.json()) as { error?: string };
  expect(body.error).toBe('forbidden');

  // 端末としてのセッションがあれば読める。**ここが通ることが縮退経路の担保**でもある
  // （`/kiosk` は #239 でセッション必須なので、構成取得に失敗した端末は必ずここを通れる）。
  await establishKioskSession(page);
  const asDevice = await page.request.get('/api/kiosk/directory');
  expect(asDevice.ok()).toBeTruthy();
});
