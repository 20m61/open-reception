import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * **一覧の読み取り失敗を「0 件」と断定しない** (#966)。
 *
 * ## なぜ静的検査だけでは足りないか
 *
 * `tests/config/admin-list-states.test.ts` は「`loaded` / `failed` を対で渡している」「一覧を
 * `T[] | null` で持つ」を**ソースの字面**で見る。`src/components/admin/list-read-state.test.tsx`
 * は実際に描くが、`renderToStaticMarkup` は `useEffect` を走らせないので**取得前の初期状態
 * しか観測できない**。独立レビューはその穴から 4 件の変異を生存させた:
 *
 *  - `if (!res.ok) { setListError(…); return; }` → `if (!res.ok) { return; }`（3 画面とも）
 *  - `loaded={items !== null || listError !== null}`（**失敗を `loaded` に混ぜて 0 件と断定**）
 *
 * 管理 API は認可越しなので、実運用で最も起きる読み取り失敗は `fetch` の reject ではなく
 * **401 / 403 / 5xx** である。つまり主要な失敗経路だけが無防備だった。
 *
 * ここは #870 の `admin-read-failure.spec.ts` と同じ方式 —— **実際に落として見る**。
 */

/** 対象 API を 500 で落とす。 */
async function failWith500(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
  );
}

/** 対象 API を 403 で落とす（権限不足・セッション切れの相当）。 */
async function failWith403(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' }),
  );
}

/** 対象 API への接続そのものを切る（`fetch` が throw する）。 */
async function failWithAbort(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) => route.abort('failed'));
}

const LISTS = [
  {
    label: 'アセット管理',
    path: '/admin/assets',
    api: '**/api/admin/assets',
    table: 'asset-table',
    alert: 'asset-list-error',
    /** 0 件だと断定する文言。失敗時に出てはいけない。 */
    assertion: '登録されたアセットはありません。',
  },
  {
    label: '部署管理',
    path: '/admin/departments',
    api: '**/api/admin/departments',
    table: 'dept-table',
    alert: 'dept-list-error',
    assertion: '登録された部署はありません。',
  },
  {
    label: '組織（来訪者への見せ方）',
    path: '/admin/organizations',
    api: '**/api/admin/organizations',
    table: 'org-table',
    alert: 'org-error',
    assertion: '組織がありません',
  },
  {
    label: '担当者管理',
    path: '/admin/staff',
    api: '**/api/admin/staff',
    table: 'staff-table',
    alert: 'staff-list-error',
    assertion: '登録された担当者はありません。',
  },
] as const;

test.describe('管理: 一覧の読み取り失敗を 0 件と断定しない (#966)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const list of LISTS) {
    /*
     * 🔴 **403 / 500 がこの画面で最も起こりやすい失敗である。** 静的検査は
     * `catch` 側しか見ておらず、非 2xx の枝には対応する主張が無かった（レビュー M1）。
     */
    for (const [name, inject] of [
      ['403', failWith403],
      ['500', failWith500],
      ['接続断', failWithAbort],
    ] as const) {
      test(`${list.label}: ${name} のとき「0 件」と断定せず、失敗を出す`, async ({ page }) => {
        await inject(page, list.api);
        await page.goto(list.path);

        // 失敗として出る（理由は表の外の `role="alert"` が持つ）。
        await expect(page.getByTestId(list.alert)).toBeVisible();
        // 0 件だと断定しない。
        await expect(page.getByTestId(`${list.table}-empty`)).toHaveCount(0);
        await expect(page.getByText(list.assertion)).toHaveCount(0);
        // 終わらない待ちにもしない。
        await expect(page.getByTestId(`${list.table}-loading`)).toHaveCount(0);
      });
    }
  }

  /*
   * 🔴 **「読めた後に読めなくなった」を無言にしない（レビュー M2）。**
   *
   * `resolveAdminReadState` は「載っていることを優先する」ので、行が 1 件でもあると
   * `DataTable` は失敗を出さない（それ自体は正しい —— 再取得の失敗で画面を空にしない）。
   * だからこそ**表の外**に失敗を出す必要がある。出さないと、再取得が落ちても運用者には
   * 何も見えず、古い一覧を最新だと信じ続ける。
   */
  test('部署管理: 読めた後の再取得が失敗したら、表は消さずに失敗を出す', async ({ page }) => {
    await page.goto('/admin/departments');
    await expect(page.getByTestId('dept-table')).toBeVisible();

    // 一覧が載っている状態で、以後の取得だけを落とす。
    await failWith500(page, '**/api/admin/departments');
    // CSV 取込の完了導線と同じく、`load()` を撃つ操作（並べ替え）で再取得させる。
    await page.getByRole('button', { name: 'down' }).first().click();

    await expect(page.getByTestId('dept-list-error')).toBeVisible();
    // 失敗しても既に載っている一覧は消さない（消すと失敗が状況を悪化させる）。
    await expect(page.getByTestId('dept-table')).toBeVisible();
  });

  /*
   * 🔴 **担当者一覧の可否を、兼務・部署の可否と混ぜない（レビュー m6）。**
   * 兼務 API だけが落ちても、担当者一覧は取れているので「取得できませんでした」にしない。
   */
  test('担当者管理: 兼務の取得だけが落ちても担当者一覧は出る', async ({ page }) => {
    await failWith500(page, '**/api/admin/organizations/memberships');
    await page.goto('/admin/staff');

    await expect(page.getByTestId('staff-table')).toBeVisible();
    await expect(page.getByTestId('staff-list-error')).toHaveCount(0);
  });
});
