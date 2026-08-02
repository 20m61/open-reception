import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 受付端末管理・失効の E2E (issue #18)。
 * seed 端末 kiosk-dev は変更せず、新規登録した端末で失効を検証する（汚染回避）。
 */

test('受付端末を登録して一覧に表示される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/kiosks');
  await expect(page.getByTestId('kiosk-row').first()).toBeVisible();
  const name = `端末-${Math.random().toString(36).slice(2, 7)}`;
  await page.getByTestId('kiosk-name-input').fill(name);
  await page.getByTestId('kiosk-add').click();
  await expect(page.getByTestId('kiosk-row').filter({ hasText: name })).toHaveCount(1);
});

test('失効した端末は config で active=false になる', async ({ page }) => {
  await loginAsAdmin(page);
  // 端末を登録し、その id で検証する（kiosk-dev には影響させない）。
  const created = await page.request.post('/api/admin/kiosks', { data: { displayName: 'revoke-target' } });
  const kiosk = (await created.json()) as { id: string };

  // **確認は admin API 経由で行う** (#601)。かつては `/api/kiosk/config?kioskId=` を
  // 使っていたが、あれは無認証で任意端末の設定を読める状態そのものだった。端末は
  // 自分の設定しか読めなくなったので、管理者としての確認は管理 API を使う。
  const enabledOf = async (id: string) => {
    const res = await page.request.get('/api/admin/kiosks');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items: { id: string; enabled: boolean }[] };
    return body.items.find((k) => k.id === id)?.enabled;
  };

  expect(await enabledOf(kiosk.id)).toBe(true);
  await page.request.post(`/api/admin/kiosks/${kiosk.id}/revoke`);
  expect(await enabledOf(kiosk.id)).toBe(false);
});

test('seed 端末 kiosk-dev は有効なまま', async ({ page }) => {
  await loginAsAdmin(page);
  const res = await page.request.get('/api/admin/kiosks');
  const body = (await res.json()) as { items: { id: string; enabled: boolean }[] };
  expect(body.items.find((k) => k.id === 'kiosk-dev')?.enabled).toBe(true);
});

/**
 * 端末設定は**自分のものしか読めない** (#601)。以前は無認証で kioskId をクエリ指定でき、
 * 任意端末の設定・メンテナンス状態・営業状態を列挙できた。
 */
test('/api/kiosk/config は kiosk セッション無しでは読めない', async ({ page }) => {
  const res = await page.request.get('/api/kiosk/config?kioskId=kiosk-dev');
  expect(res.status()).toBe(403);
});

test('受付端末管理ページは未認証だとログインへリダイレクト', async ({ page }) => {
  await page.goto('/admin/kiosks');
  await expect(page).toHaveURL(/\/admin\/login$/);
});
