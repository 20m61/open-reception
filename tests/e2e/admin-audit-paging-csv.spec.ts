import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 監査ログのページングと CSV (#905 / 課題 17)。
 *
 * それまで監査ログは**絞り込み後の全件をそのまま DOM へ描いて**おり、ページングも
 * CSV も無かった。兄弟の受付履歴（`/admin/receptions`）は 3 つとも持っており、
 * `app/admin/receptions/page.tsx` は「監査ログと同じ設計」と書いていた ——
 * 実際には監査ログの方が遅れていた。
 */

test('監査ログが 1 ページあたりの件数で区切られる', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  /*
   * 🔴 **前提をページャ自身の有無から立てない。** `if (ページャが見えたら…)` と書くと、
   * ページャが二度と描画されなくなった世界でも緑になる（＝直そうとしている欠陥そのもの）。
   * 件数表示から前提を立て、満たないなら**声を上げて落ちる**ようにする。
   */
  const countText = (await page.getByTestId('audit-count').textContent()) ?? '';
  const total = Number(/(\d+)\s*件を表示/.exec(countText)?.[1]);
  expect(total, `seed の監査ログが PAGE_SIZE 以下だと、この検査は空虚になる: ${countText}`)
    .toBeGreaterThan(20);

  // ちょうど 1 ページぶんしか描かない。全件描画に戻ると、ここが最初に落ちる。
  await expect(page.getByTestId('audit-row')).toHaveCount(20);

  await expect(page.getByTestId('audit-pagination')).toBeVisible();
  await expect(page.getByTestId('audit-page-prev')).toBeDisabled();
  await page.getByTestId('audit-page-next').click();
  await expect(page.getByTestId('audit-page-prev')).toBeEnabled();
  // ページ番号は URL に載る（戻る/進む・共有で復元される）。
  expect(page.url()).toContain('page=2');
});

test('CSV エクスポートが押せて、件数 0 のときは押せない', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();

  const exportButton = page.getByTestId('audit-csv-export');
  await expect(exportButton).toBeEnabled();

  // 一致しない条件で絞ると 0 件になり、書き出すものが無いので押せなくなる。
  await page.getByTestId('audit-filter-actor').fill('存在しない主体-zzzz');
  await expect(page.getByTestId('audit-row')).toHaveCount(0);
  await expect(exportButton).toBeDisabled();
});

test('フィルタを変えるとページが 1 に戻る（空ページへ迷い込まない）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit?page=2');
  await page.getByTestId('audit-filter-keyword').fill('a');
  // `page` は空になる（= 1 ページ目）。
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeFalsy();
});

test('フィルタのラベルと入力が結ばれている', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/audit');
  // 共有 `ui/Field` 経由になったので、ラベルから入力を引ける。
  await expect(page.getByLabel('主体')).toBeVisible();
  await expect(page.getByLabel('キーワード')).toBeVisible();
  // #894 の aria 配線が効いている（hint が入力へ結ばれる）。
  const describedBy = await page.getByTestId('audit-filter-actor').getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();
});
