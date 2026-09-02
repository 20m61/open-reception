import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 対象テナント context の安全側フォールバック (#423)。
 *
 * 純関数（`resolveActiveTenantId`）は「越境 cookie を採用せず選択肢の先頭へ倒す」ことを
 * unit で固定済み。**しかし画面まで通しての検証が無かった。** cookie → server 解決 → 画面表示の
 * 経路のどこかで別の読み方をすれば、純関数が正しくても破れる（このセッションで #489 → #492 が
 * 実証した「契約は正しいのに画面が自前で判断していた」と同じ形）。
 *
 * 注: 第 2 テナントを作る API が無い（seed は `internal` のみ）ため、**越境そのものではなく
 * 「存在しない/不正な context を渡したときに安全側へ倒れるか」**を検証する。実テナント間の
 * 越境 e2e はテナント作成 API が入ってから。
 */

const ACTIVE_TENANT_COOKIE = 'or_active_tenant';

async function setTenantCookie(page: import('@playwright/test').Page, value: string) {
  const url = new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url());
  await page.context().addCookies([
    { name: ACTIVE_TENANT_COOKIE, value, domain: url.hostname, path: '/' },
  ]);
}

test.describe('対象テナント context の安全側フォールバック (#423)', () => {
  test('存在しないテナント id の cookie でも画面が壊れず、既定テナントへ倒れる', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/admin');
    await setTenantCookie(page, 'no-such-tenant');
    await page.goto('/admin');

    // 500 やエラー画面にならず、対象テナント表示が出る（安全側へ倒れた証拠）。
    const active = page.getByTestId('active-tenant');
    await expect(active).toBeVisible();
    // 存在しない id がそのまま表示へ漏れない。
    await expect(active).not.toContainText('no-such-tenant');
  });

  test('壊れた cookie 値でも画面が壊れない', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin');
    // 制御文字・記号を含む不正値。cookie として保存できる範囲で壊す。
    await setTenantCookie(page, '../../etc/passwd');
    await page.goto('/admin');

    await expect(page.getByTestId('active-tenant')).toBeVisible();
  });

  test('画面を移動しても対象テナントが暗黙に変わらない', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin');
    const before = await page.getByTestId('active-tenant').textContent();
    expect(before).toBeTruthy();

    // 管理画面のいくつかを渡り歩く。どこかで context を落とすと表示が変わる。
    // 対象テナント表示は `/admin/layout.tsx`（唯一の admin layout）が出すので全画面に在る。
    // count()===0 を黙って読み飛ばすと**全部スキップされても緑**になるため、明示的に要求する。
    const paths = ['/admin/sites', '/admin/audit', '/admin'];
    for (const path of paths) {
      await page.goto(path);
      const label = page.getByTestId('active-tenant');
      await expect(label, `${path} に対象テナント表示が無い`).toHaveCount(1);
      await expect(label, path).toHaveText(before!);
    }
  });
});
