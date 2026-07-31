// **kiosk-fixtures からは import しない。** あちらの `test` は毎テスト
// `establishKioskSession` を走らせ、端末を 1 台作ってエンロールしたまま消さない。
// この spec は管理画面の読み取りだけなのに、実行のたびに端末が増え、しかも
// **その端末一覧を assert している**（自分で汚した対象を検査することになる）。
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 拠点スコープが URL で表現されることの実 UI 検証 (#421)。
 *
 * 純関数側（`site-scope.test.ts`）は解決規則を固定しているが、**実際に URL から読まれて
 * セレクタへ反映されるか**は配線の話なので unit では見えない。第 87 wave で
 * 「純関数は正しいのに配線が stale」という同型の欠陥を踏んでいるため、実ルートで見る。
 *
 * **なぜ seed に 2 拠点目が要るか**（`src/lib/tenant/store.ts` の `branch-site`）:
 * 拠点が 1 件だと、**URL を一切見ない実装（先頭サイトを自動選択）でも同じ結果になる**ため、
 * ここに書くテストは何をしても pass する＝検証になっていない。増分 1 で実際にそうなった
 * （2 本とも変更前から pass していた）。2 件目を置いて初めて「切り替えが URL に載り、
 * リロードで保たれる」を実証できる。
 *
 * 既存 spec への影響が無いことは確認済み: 拠点を触る e2e は全て `default-site` を明示指定し、
 * `capture-screens.spec.ts` は `page.screenshot()` で撮るだけ（VRT 比較をしない）。
 */
test.describe('管理: 拠点スコープが URL に載る (#421)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('URL の siteId が拠点セレクタへ反映される', async ({ page }) => {
    await page.goto('/admin/devices?siteId=default-site');

    // testid で名指しする。`locator('select').first()` だと、複数テナントに所属する
    // 管理者ではヘッダの TenantSwitcher が先に出て**テナント選択の方を掴む**。
    await expect(page.getByTestId('device-site-select')).toHaveValue('default-site');
  });

  test('拠点を切り替えると URL に載り、リロードしても保たれる', async ({ page }) => {
    // **これが「URL が真実源」であることの実証。** 拠点が 1 件しか無いと、URL を一切見ない
    // 旧実装（先頭サイトを自動選択）でも同じ結果になり検証にならないため、seed に 2 件目
    // （`branch-site`）を置いてある。
    await page.goto('/admin/devices');
    const select = page.getByTestId('device-site-select');
    await expect(select).toHaveValue('default-site');

    await select.selectOption('branch-site');
    await expect(page).toHaveURL(/siteId=branch-site/);
    await expect(select).toHaveValue('branch-site');

    // リロードしても選択が戻らない（component state だった頃はここで先頭へ戻っていた）。
    await page.reload();
    await expect(page.getByTestId('device-site-select')).toHaveValue('branch-site');
  });

  test('実在しない siteId は採用せず、実在する拠点へ倒す', async ({ page }) => {
    // ここが安全側の肝。存在しない id をそのまま選択状態にすると、端末一覧が空になり
    // 「この拠点には端末が無い」と**事実と異なる読み方**をされる。
    await page.goto('/admin/devices?siteId=no-such-site');

    await expect(page.getByTestId('device-site-select')).toHaveValue('default-site');
    // 実在拠点へ倒れているので、一覧は「空」ではなく実データが出る。
    await expect(page.getByText('このサイトに登録された受付端末はありません。')).toHaveCount(0);
  });
});
