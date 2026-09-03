import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 列ソート (#909 / 課題 18)。
 *
 * それまで `aria-sort` もソートハンドラも **0 件**で、一覧は取得順のまま出ていた。
 * 「最近の失敗を探す」「名前で探す」がフィルタでしかできなかった。
 */

test('ヘッダを押すと aria-sort が none → ascending → descending → none と回る', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  const header = page.getByTestId('audit-table').locator('th').filter({ hasText: '主体' });
  const button = page.getByTestId('audit-table-sort-actor');

  await expect(header).toHaveAttribute('aria-sort', 'none');
  await button.click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await button.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await button.click();
  // 🔴 解除できることが要る。既定の順序（監査ログは新しい順）へ戻せないと情報が失われる。
  await expect(header).toHaveAttribute('aria-sort', 'none');
});

test('並べ替えが実際に順序を変え、URL に載る', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  // 行ごとの 3 列目（主体）。`locator('td').nth(2)` は行をまたいだ集合の 3 番目になるので使わない。
  const actorsOnPage = async () =>
    page.locator('[data-testid="audit-row"] td:nth-child(3)').allTextContents();

  const before = await actorsOnPage();
  await page.getByTestId('audit-table-sort-actor').click();
  // 押した直後に読むと再描画前の値を掴む。状態が反映されたことを待ってから読む。
  await expect(
    page.getByTestId('audit-table').locator('th').filter({ hasText: '主体' }),
  ).toHaveAttribute('aria-sort', 'ascending');
  const asc = await actorsOnPage();

  expect(asc).not.toEqual(before);
  expect([...asc].sort()).toEqual(asc);

  const url = new URL(page.url());
  expect(url.searchParams.get('sort')).toBe('actor');
  expect(url.searchParams.get('sortDir')).toBe('asc');
});

test('並べ替えはリロードで復元される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit?sort=actor&sortDir=desc');
  const header = page.getByTestId('audit-table').locator('th').filter({ hasText: '主体' });
  await expect(header).toHaveAttribute('aria-sort', 'descending');

  const actors = await page.locator('[data-testid="audit-row"] td:nth-child(3)').allTextContents();
  expect([...actors].sort().reverse()).toEqual(actors);
});

test('🔴 並べ替えはページングより先に効く（1 ページぶんだけ並び替わらない）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit?sort=actor&sortDir=asc');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  const firstPage = await page.locator('[data-testid="audit-row"] td:nth-child(3)').allTextContents();
  const last = firstPage[firstPage.length - 1] ?? '';

  await page.getByTestId('audit-page-next').click();
  const secondPage = await page.locator('[data-testid="audit-row"] td:nth-child(3)').allTextContents();
  const first = secondPage[0] ?? '';

  /*
   * ページを切ってから並べ替える実装だと、2 ページ目の先頭が 1 ページ目の末尾より
   * 小さくなりうる（各ページの中だけが整列する）。全体で整列していれば境界も守られる。
   */
  expect(first >= last, `1 ページ目の末尾 "${last}" より 2 ページ目の先頭 "${first}" が小さい`).toBe(true);
});

test('下界: ソート不可の列にはボタンも aria-sort も出ない', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  // 「対象」列は sortValue を持たない。押せるように見せない。
  const header = page.getByTestId('audit-table').locator('th').filter({ hasText: '対象' });
  await expect(header).toHaveCount(1);
  await expect(header).not.toHaveAttribute('aria-sort', /.*/);
  await expect(header.locator('button')).toHaveCount(0);
});

/**
 * #910: 部署は**表示順そのものが業務上の値**なので、並べ替えを解除して既定へ戻せることが要る。
 *
 * 監査ログ（上）は「新しい順」という自明な既定へ戻るだけだが、部署の既定は運用者が
 * ドラッグで作った並びで、**戻せないと作り直しになる**。
 */
test('部署: 並べ替えを解除すると既定の表示順へ戻る (#910)', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-table')).toBeVisible();

  const names = async () =>
    page.locator('[data-testid="dept-row"] [data-testid="dept-name"]').allTextContents();

  const defaultOrder = await names();
  // 既定の並びが 2 件以上ないと「戻った」が判定できない。
  expect(defaultOrder.length).toBeGreaterThan(1);

  const header = page.getByTestId('dept-table').locator('th').filter({ hasText: '部署名' });
  const button = page.getByTestId('dept-table-sort-name');

  await button.click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await button.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  const descending = await names();

  await button.click();
  await expect(header).toHaveAttribute('aria-sort', 'none');
  // 🔴 既定の並びが**そのまま**戻る（「解除したが取得順に化けた」を落とす）。
  expect(await names()).toEqual(defaultOrder);
  // 下界: 途中で本当に並びが変わっていた（解除の主張が空虚でない）。
  expect(descending).not.toEqual(defaultOrder);
});

/**
 * #910: 並べ替えが URL に載り、**ページ指定を落とす**。
 *
 * 🔴 **書けることだけを主張する。** AC2 は「ページングを入れた一覧は URL に `page` を持ち、
 * フィルタ変更でページが 1 に戻る」だが、**e2e の seed は担当者 6 件**（実測）で
 * `PAGE_SIZE = 20` に届かず、ページ送りは描画されない。つまりこの環境では
 * **2 ページ目という状態を作れない**ので、「フィルタでページが 1 に戻る」を実演できない。
 *
 * 実演できないものを緑で飾らず、ここでは**確かめられること**だけを見る ——
 * 並べ替えが URL に載り、`page` を持ち越さないこと。ページングの算術と
 * 「押せる/押せない」は `src/components/admin/ui/Pager.test.tsx` と `list-io` の
 * `paginate` の unit が、**`sortRows` → `paginate` の順序**は
 * `tests/config/table-sort-adoption.test.ts` が縛っている。
 */
test('担当者: 並べ替えが URL に載り、ページ指定を持ち越さない (#910)', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/staff?page=2');
  await expect(page.getByTestId('staff-table')).toBeVisible();

  // 前提の明示: 1 ページに収まっているのでページ送りは出ない（出るなら上の注記が古い）。
  await expect(page.getByTestId('staff-pagination')).toHaveCount(0);

  await page.getByTestId('staff-table-sort-name').click();
  await expect(
    page.getByTestId('staff-table').locator('th').filter({ hasText: '氏名' }),
  ).toHaveAttribute('aria-sort', 'ascending');

  const url = new URL(page.url());
  expect(url.searchParams.get('sort')).toBe('name');
  // 並べ替えを変えたらページ指定は落とす（順序が変われば 2 ページ目の中身は別物）。
  expect(url.searchParams.get('page') ?? '').toBe('');
});
