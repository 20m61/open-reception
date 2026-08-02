import { test, expect, type Page } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 組織の見せ方の管理 (#373 増分 6)。
 *
 * **この画面の価値は「編集が来訪者へ届くこと」に尽きる。** 管理画面で保存できても
 * 受付端末の表示が変わらなければ意味がない。管理画面での編集 → 来訪者向けの応答、という
 * 一巡を通しで検査する。
 *
 * ## 各テストが自分の組織を作る
 *
 * 「一覧の先頭」を共有すると、片方のテストが非公開にした組織をもう片方が掴んでフレークする
 * （実際にそうなった）。project 内は並行実行されるので、**共有状態を前提にしない**。
 */

function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 受付端末が**実際に使う**経路（実効構成）からディレクトリを読む。
 *
 * `/api/kiosk/directory` を見てはいけない。あれは実効構成が落ちたときの**縮退経路**で、
 * #588 の判断により旧実装（組織モデルを読まない）のまま残してある。そちらを検査すると
 * 「編集が届いていない」ように見えるが、実経路では届いている（実際にこれで一度誤診した）。
 */
async function visitorDepartments(page: Page): Promise<{ id: string; name: string }[]> {
  const res = await page.request.get('/api/configuration/effective');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    directory?: { departments?: { id: string; name: string }[] };
  };
  return body.directory?.departments ?? [];
}

/** このテスト専用の部署を作り、その id を返す。 */
async function createOwnDepartment(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/admin/departments', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

test('公開表示名の編集が来訪者向けディレクトリへ届く', async ({ page }) => {
  await loginAsAdmin(page);
  const id = await createOwnDepartment(page, uniq('編集対象'));

  await page.goto('/admin/organizations');
  await expect(page.getByTestId('org-table')).toBeVisible();

  const renamed = uniq('お客さま窓口');
  await page.getByTestId(`org-public-name-${id}`).fill(renamed);
  await page.getByTestId(`org-save-${id}`).click();

  // 来訪者向けの応答が変わる。ここが通らなければ、この画面は何も達成していない。
  await expect(async () => {
    expect((await visitorDepartments(page)).find((d) => d.id === id)?.name).toBe(renamed);
  }).toPass({ timeout: 10_000 });
});

/**
 * 「保存したのに出ない」を運用者が自力で直せること。理由を出さないと設定を触り回すことになる。
 */
test('来訪者に出さない設定にすると、理由付きで「見えない」と出る', async ({ page }) => {
  await loginAsAdmin(page);
  const id = await createOwnDepartment(page, uniq('非公開対象'));

  await page.goto('/admin/organizations');
  await expect(page.getByTestId(`org-visible-${id}`)).toBeVisible();

  await page.getByTestId(`org-toggle-public-${id}`).click();

  const hidden = page.getByTestId(`org-hidden-${id}`);
  await expect(hidden).toBeVisible();
  await expect(hidden).toContainText('来訪者に出さない設定');

  // 来訪者向けの一覧からも消える。
  await expect(async () => {
    expect((await visitorDepartments(page)).some((d) => d.id === id)).toBe(false);
  }).toPass({ timeout: 10_000 });
});
