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
    /** 表の中の失敗文言。画面ごとに違うので、定数へ潰す変異が落ちる。 */
    failureMessage: 'アセット一覧を読み込めませんでした。',
  },
  {
    label: '部署管理',
    path: '/admin/departments',
    api: '**/api/admin/departments',
    table: 'dept-table',
    alert: 'dept-list-error',
    assertion: '登録された部署はありません。',
    /** 表の中の失敗文言。画面ごとに違うので、定数へ潰す変異が落ちる。 */
    failureMessage: '部署一覧を読み込めませんでした。',
  },
  {
    label: '組織（来訪者への見せ方）',
    path: '/admin/organizations',
    api: '**/api/admin/organizations',
    table: 'org-table',
    alert: 'org-error',
    assertion: '組織がありません',
    /** 表の中の失敗文言。画面ごとに違うので、定数へ潰す変異が落ちる。 */
    failureMessage: '組織一覧を読み込めませんでした。',
  },
  {
    label: '担当者管理',
    path: '/admin/staff',
    api: '**/api/admin/staff',
    table: 'staff-table',
    alert: 'staff-list-error',
    assertion: '登録された担当者はありません。',
    /** 表の中の失敗文言。画面ごとに違うので、定数へ潰す変異が落ちる。 */
    failureMessage: '担当者一覧を読み込めませんでした。',
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
        const alert = page.getByTestId(list.alert);
        await expect(alert).toBeVisible();
        /*
         * 🔴 **読み上げへ届くこと (#966 レビュー 2 周目 m1)。**
         * 行が載っている状態での再取得失敗では**表の中の polite は描かれない**
         * （`resolveAdminReadState` が `loaded` を優先する）ので、ここが唯一の
         * 読み上げ経路。`role` を落とす変異が unit・e2e とも素通りしていた。
         */
        await expect(alert).toHaveAttribute('role', 'alert');
        /*
         * 🔴 **文言が定型文へ潰れていないこと (#966 レビュー 2 周目 m4)。**
         * `catch` の中身を `setListError('x')` にする変異は、静的検査の
         * 「空値でない引数」を満たすので素通りしていた。実際に読まれる文字列を見る。
         */
        await expect(alert).toContainText('できませんでした');
        /*
         * 🔴 **表の中の文言が画面ごとに配線されていること (#966 レビュー 2 周目 m3)。**
         * `DataTable` の `message={failureMessage ?? '…'}` を定数へ潰す変異
         * （＝4 画面ぶんの配線を全部無視する）が unit・e2e とも素通りしていた。
         */
        await expect(page.getByText(list.failureMessage)).toBeVisible();
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
    /*
     * 🔴 **共有フィクスチャを書き換えない (#966 レビュー 2 周目 MAJOR-3)。**
     *
     * 並べ替えの実体は `POST /api/admin/departments/{id}/move` で、上の glob
     * （`departments` で終わるパターン）は**この URL に一致しない**
     * （Playwright の glob はパス末尾で止まる）。
     * つまり intercept をすり抜けて**実サーバの表示順が本当に変わり**、`afterEach` も
     * 無いので戻らない。同じ project には部署の既定順を読む spec
     * （`admin-table-sort` / `admin-dnd`）が同居しており、
     * `admin-vrt-a11y.spec.ts` には**まさにこの共有フィクスチャのせいで部署一覧の VRT を
     * 諦めた**注記が残っている。`.claude/rules/opus5-autonomous-loop.md`
     * 「テストの隔離は『project を分けた』では足りない」の型。
     *
     * `load()` だけを落としたいので、move は 200 で握って**サーバ状態を触らない**。
     */
    await page.route('**/api/admin/departments/*/move', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
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
  for (const [name, inject] of [
    ['500', failWith500],
    ['接続断', failWithAbort],
  ] as const) {
    /*
     * 🔴 **接続断を踏むこと (#966 レビュー 2 周目 MAJOR-1)。**
     *
     * 1 周目は `failWith500` だけを当てていた。`Promise.all` は **reject でしか
     * 壊れない**ので、500 だけを踏むテストは**直した半分しか見ていなかった** ——
     * レビューの実測では、兼務や部署の接続断で担当者一覧が画面から消え、
     * 「担当者一覧を取得できませんでした」という**嘘の原因**が出ていた
     * （担当者 API は 200 を返している）。この repo の管理 API は `Connection: close`
     * を返すので、1 本だけ `ECONNRESET` になる形は実際に踏んだことがある。
     */
    test(`担当者管理: 兼務の取得が ${name} でも担当者一覧は出る`, async ({ page }) => {
      await inject(page, '**/api/admin/organizations/memberships');
      await page.goto('/admin/staff');

      await expect(page.getByTestId('staff-table')).toBeVisible();
      await expect(page.getByTestId('staff-list-error')).toHaveCount(0);
      // 🔴 兼務が読めなかったことは**別に**告げる（黙って「兼務なし」にしない）。
      await expect(page.getByTestId('staff-aux-error')).toBeVisible();
      await expect(page.getByTestId('staff-aux-error')).toContainText('兼務');
    });

    test(`担当者管理: 部署の取得が ${name} でも担当者一覧は出る`, async ({ page }) => {
      await inject(page, '**/api/admin/departments');
      await page.goto('/admin/staff');

      await expect(page.getByTestId('staff-table')).toBeVisible();
      await expect(page.getByTestId('staff-list-error')).toHaveCount(0);
      await expect(page.getByTestId('staff-aux-error')).toBeVisible();
      await expect(page.getByTestId('staff-aux-error')).toContainText('部署');

      /*
       * 🔴 **押しても何も起きないボタンにしない (#966 レビュー 2 周目 MAJOR-2)。**
       * 部署が読めていないと `add()` は `departmentId === ''` で黙って return する。
       *
       * 🔴 **氏名を先に入れる。** 空欄のままだと `displayName.trim() === ''` の側で
       * **既に無効**なので、`departments === null` の guard を外す変異が素通りする
       * （実測で生存）。レビューが MAJOR-1 で指摘した「弱い側の入力だけを踏む
       * テスト」と同型を、その修正のテストで踏んでいた。
       */
      await page.getByTestId('staff-name-input').fill('e2e 太郎');
      await expect(page.getByTestId('staff-add')).toBeDisabled();
      // 「部署が設定されていない」と読める `-` を全行に出さない。
      await expect(page.getByText('取得できていません').first()).toBeVisible();
    });
  }

  /*
   * 🔴 **0 件のときの見出しが配線されていること (#966 レビュー 2 周目 m5)。**
   *
   * `OrganizationsManager` は 1 周目まで表の**外**の `EmptyState` で 0 件を断定して
   * いたので、`DataTable` へ寄せるときに見出しを `emptyTitle` で取り戻した。
   * その配線を落とす変異が素通りしていた（`DataTable.test.tsx` は部品側だけを縛り、
   * **配線は縛っていない** —— このファイル自身が警告している型）。
   */
  test('組織: 0 件のときは見出し付きで「無い」と言う（失敗と区別する）', async ({ page }) => {
    await page.route('**/api/admin/organizations', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // 🔴 `unresolvedStaffIds` も画面が読む。欠けると render が壊れる
        //    （形の壊れた 200 —— 管理画面側の同族は #973）。
        body: '{"items":[],"unresolvedStaffIds":[]}',
      }),
    );
    await page.goto('/admin/organizations');

    await expect(page.getByText('組織がありません')).toBeVisible();
    // 0 件は失敗ではない（下界。全部を失敗と断定する変異が空虚に通るのを止める）。
    await expect(page.getByTestId('org-error')).toHaveCount(0);
  });

  /*
   * 🔴 **復帰したら失敗表示が消えること (#966 レビュー 2 周目 m2)。**
   * 成功枝の `setListError(null)` を削る変異が unit・e2e とも素通りしていた。
   * 実害は「一度失敗したら、次に読めても失敗表示が残り続ける」。
   */
  for (const list of LISTS) {
    test(`${list.label}: 復帰したら失敗表示が消える`, async ({ page }) => {
      await failWith500(page, list.api);
      await page.goto(list.path);
      await expect(page.getByTestId(list.alert)).toBeVisible();

      await page.unroute(list.api);
      await page.reload();

      await expect(page.getByTestId(list.table)).toBeVisible();
      await expect(page.getByTestId(list.alert)).toHaveCount(0);
    });
  }

  /*
   * 🔴 **`catch` に到達する入力を踏む (#966 レビュー 2 周目の変異 A7)。**
   *
   * `Promise.allSettled` にしたことで、**reject は `status === 'rejected'` の枝が
   * 拾う**ようになり、`catch` に来るのは `json()` が投げるとき（＝壊れた本文の 200）
   * だけになった。接続断しか注入していなかったので、`catch` の中身を
   * `setListError('x')` へ潰す変異が素通りしていた ——
   * **修正が経路の意味を変えたのに、テストは前の経路のままだった。**
   */
  test('担当者管理: 本文が壊れた 200 でも「取得できませんでした」と言う', async ({ page }) => {
    await page.route('**/api/admin/staff', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }),
    );
    await page.goto('/admin/staff');

    const alert = page.getByTestId('staff-list-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('できませんでした');
  });
});
