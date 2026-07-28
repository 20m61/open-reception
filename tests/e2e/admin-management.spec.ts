import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 部署・担当者管理の E2E (issue #3, #25, #26)。
 * 共有 in-memory ストア汚染を避けるため、seed データは変更せず一意名で新規追加・操作する。
 */

function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

test('部署を追加すると一覧と受付端末に反映される', async ({ page }) => {
  const name = uniq('部署');
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  // クライアントの読み込み完了（=ハイドレーション済み）を待ってから入力する。
  await expect(page.getByTestId('dept-row').first()).toBeVisible();
  await page.getByTestId('dept-name-input').fill(name);
  await page.getByTestId('dept-add').click();

  const row = page.getByTestId('dept-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);

  // 受付端末のディレクトリにも現れる（コード変更なしで反映）。
  const res = await page.request.get('/api/kiosk/directory');
  expect(res.ok()).toBeTruthy();
  const dir = (await res.json()) as { departments: { name: string }[] };
  expect(dir.departments.some((d) => d.name === name)).toBe(true);
});

test('追加した部署を無効化できる', async ({ page }) => {
  const name = uniq('無効化部署');
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-row').first()).toBeVisible();
  await page.getByTestId('dept-name-input').fill(name);
  await page.getByTestId('dept-add').click();

  const row = page.getByTestId('dept-row').filter({ hasText: name });
  await expect(row).toContainText('有効');
  await row.getByTestId('dept-toggle').click();
  await expect(row).toContainText('無効');
});

test('担当者を追加して無効化できる', async ({ page }) => {
  const name = uniq('担当');
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  await expect(page.getByTestId('staff-row').first()).toBeVisible();
  await page.getByTestId('staff-name-input').fill(name);
  await page.getByTestId('staff-add').click();

  const row = page.getByTestId('staff-row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('有効');

  await row.getByTestId('staff-toggle').click();
  await expect(row).toContainText('無効');
});

test('担当者一覧を氏名・部署・状態で絞り込める（#330 item2）', async ({ page }) => {
  const name = uniq('絞込担当');
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  await expect(page.getByTestId('staff-row').first()).toBeVisible();
  await page.getByTestId('staff-name-input').fill(name);
  await page.getByTestId('staff-add').click();
  await expect(page.getByTestId('staff-row').filter({ hasText: name })).toHaveCount(1);

  // 氏名の部分一致で絞り込むと URL に反映され、当該行のみ表示される。
  await page.getByTestId('staff-filter-keyword').fill(name);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(name)}`));
  await expect(page.getByTestId('staff-row')).toHaveCount(1);
  await expect(page.getByTestId('staff-row')).toContainText(name);

  // 状態フィルタと組み合わせても該当する（既定は有効）。
  await page.getByTestId('staff-filter-status').selectOption('enabled');
  await expect(page.getByTestId('staff-row')).toHaveCount(1);
  await page.getByTestId('staff-filter-status').selectOption('disabled');
  await expect(page.getByTestId('staff-table-empty')).toBeVisible();

  await page.getByTestId('staff-filter-reset').click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(page.getByTestId('staff-row').filter({ hasText: name })).toHaveCount(1);
});

test('受付端末は管理画面の部署・担当者を取得して表示する', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // seed の担当者・部署が API 経由で表示される。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
});

/**
 * 作った画面がナビから辿れること (issue #421)。
 *
 * `/admin/experience-versions`（受付体験の公開と端末への反映状況）は第 21 wave で作ったが、
 * `ADMIN_NAV` にも他画面からのリンクにも登録されず、**URL を直打ちする以外に開けない**まま
 * 放置されていた。運用者から見れば「作られていない」のと同じなので、実ブラウザで固定する。
 */
test('受付体験の公開・反映状況へサイドバーから到達できる', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin');

  // iPad 幅ではサイドバーが畳まれている（ハンバーガーで開く）。
  const hamburger = page.getByRole('button', { name: 'メニューを開く' });
  if (await hamburger.isVisible()) await hamburger.click();

  await page.getByRole('link', { name: '公開と反映状況' }).click();
  await expect(page).toHaveURL(/\/admin\/experience-versions/);
  // 版が 0 件のテナントでは表ではなく空状態が出るので、見出しで到達を判定する
  // （このテストが固定したいのは「ナビから開ける」ことであって、版の有無ではない）。
  await expect(page.getByRole('heading', { name: '受付体験の版' })).toBeVisible({ timeout: 15_000 });
});
