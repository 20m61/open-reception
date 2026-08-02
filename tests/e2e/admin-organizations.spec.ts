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

/**
 * **縮退中も「来訪者に出さない」が尊重されること** (#597)。
 *
 * `/api/kiosk/directory` は実効構成が落ちたときの逃げ道。かつてここだけ組織モデルを
 * 読まなかったため、**構成取得が落ちている間だけ隠したはずの組織が再び出て**いた。
 * 管理画面は「見えない」と表示しているので、運用者からは気づけない fail-open だった。
 */
test('縮退経路でも「来訪者に出さない」が尊重される', async ({ page }) => {
  await loginAsAdmin(page);
  const id = await createOwnDepartment(page, uniq('縮退時非公開'));

  await page.goto('/admin/organizations');
  await page.getByTestId(`org-toggle-public-${id}`).click();
  await expect(page.getByTestId(`org-hidden-${id}`)).toBeVisible();

  // 縮退経路を直接叩く（実効構成が落ちたときに端末が使う経路そのもの）。
  await expect(async () => {
    const res = await page.request.get('/api/kiosk/directory');
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { departments: { id: string }[] };
    expect(body.departments.some((d) => d.id === id)).toBe(false);
  }).toPass({ timeout: 10_000 });
});

/** 縮退経路でも公開表示名の編集が反映される（管理画面と食い違わない）。 */
test('縮退経路でも公開表示名の編集が反映される', async ({ page }) => {
  await loginAsAdmin(page);
  const id = await createOwnDepartment(page, uniq('縮退時改名'));

  await page.goto('/admin/organizations');
  const renamed = uniq('縮退窓口');
  await page.getByTestId(`org-public-name-${id}`).fill(renamed);
  await page.getByTestId(`org-save-${id}`).click();

  await expect(async () => {
    const res = await page.request.get('/api/kiosk/directory');
    const body = (await res.json()) as { departments: { id: string; name: string }[] };
    expect(body.departments.find((d) => d.id === id)?.name).toBe(renamed);
  }).toPass({ timeout: 10_000 });
});

/**
 * 階層（上位組織）の編集 (#373 増分 7)。
 *
 * 循環した階層は祖先を辿る処理が終わらず、来訪者画面の描画ごと巻き込む。サーバは
 * `canSetParent` で拒否するが、**選べてしまう UI は運用者に「なぜ保存できないのか」を
 * 考えさせる**ので、候補からも外れていることを確認する。
 */
test('上位組織を設定でき、循環になる候補は選べない', async ({ page }) => {
  await loginAsAdmin(page);
  const parent = await createOwnDepartment(page, uniq('本部'));
  const child = await createOwnDepartment(page, uniq('一課'));

  await page.goto('/admin/organizations');
  await expect(page.getByTestId('org-table')).toBeVisible();

  await page.getByTestId(`org-parent-${child}`).selectOption(parent);
  await expect(page.getByTestId(`org-parent-${child}`)).toHaveValue(parent);

  // 親の側から見ると、子は候補に出ない（選ぶと循環になる）。
  const parentOptions = page.getByTestId(`org-parent-${parent}`).locator('option');
  await expect(parentOptions.filter({ hasText: new RegExp(child) })).toHaveCount(0);

  // 自分自身も候補に出ない。
  const childOptions = page.getByTestId(`org-parent-${child}`).locator('option');
  await expect(childOptions.filter({ hasText: new RegExp(child) })).toHaveCount(0);
});

/**
 * 兼務の設定 (#373 増分 8)。
 *
 * 同姓同名の識別ラベルは兼務を「営業部（兼: 技術部）」と表示するが、**兼務を作る経路が
 * 本番に 1 つも無かった**。表示側だけ在って生産者が無い契約は腐るので、管理画面で設定し
 * 来訪者面へ届くところまでを通しで検査する。
 */
test('兼務を設定すると来訪者の所属表示に併記される', async ({ page }) => {
  await loginAsAdmin(page);
  const mainId = await createOwnDepartment(page, uniq('主所属'));
  const alsoId = await createOwnDepartment(page, uniq('兼務先'));

  const created = await page.request.post('/api/admin/staff', {
    data: { displayName: uniq('兼務太郎'), departmentId: mainId },
  });
  expect(created.ok()).toBeTruthy();
  const staffId = ((await created.json()) as { id: string }).id;

  await page.goto('/admin/staff');
  await page.getByTestId(`staff-${staffId}-secondary-add`).selectOption(alsoId);
  await expect(page.getByTestId(`staff-${staffId}-secondary-${alsoId}`)).toBeVisible();

  // 来訪者向けの応答に兼務が載る。ここが通らなければ設定経路を作った意味がない。
  await expect(async () => {
    const res = await page.request.get('/api/configuration/effective');
    const body = (await res.json()) as {
      directory?: { staff?: { id: string; affiliation?: { secondary: string[] } }[] };
    };
    const entry = body.directory?.staff?.find((s) => s.id === staffId);
    expect(entry?.affiliation?.secondary).toHaveLength(1);
  }).toPass({ timeout: 10_000 });

  // 外すと消える。
  await page.getByTestId(`staff-${staffId}-secondary-remove-${alsoId}`).click();
  await expect(page.getByTestId(`staff-${staffId}-secondary-${alsoId}`)).toHaveCount(0);
});

