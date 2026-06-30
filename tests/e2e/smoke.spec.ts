import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 基盤の smoke test (issue #9 → docs/reception-issuance-design.md inc1)。
 * LP はログイン主導線に整理し、受付端末（/kiosk）は管理画面が発行する受付URL/QR から
 * のみ到達させる。よって LP に公開 /kiosk 直リンクは置かない。
 */
test('トップにログイン導線が表示され、公開 /kiosk 直リンクは無い', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'open-reception' })).toBeVisible();
  await expect(page.getByTestId('lp-login')).toBeVisible();
  await expect(page.getByTestId('lp-login')).toHaveAttribute('href', '/admin/login');
  await expect(page.locator('a[href="/kiosk"]')).toHaveCount(0);
});

test('受付待機画面が表示される', async ({ page }) => {
  await page.goto('/kiosk');
  // タッチファースト再設計 (#121): 待機画面は用件選択のクイックアクションを大きく出す。
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('管理ダッシュボードが表示される（要ログイン）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
});

test('ダッシュボードに利用量・予想コスト概況と詳細への導線がある（#86）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');
  await expect(page.getByText('今月の予想コスト（概算）')).toBeVisible();
  // 概況カードから利用量/コスト詳細へ誘導する（集約 API・準備中ではない）。
  await expect(page.locator('a[href="/admin/usage"]').first()).toBeVisible();
  await expect(page.locator('a[href="/admin/costs"]').first()).toBeVisible();
});
