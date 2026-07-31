import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 拠点スコープが URL で表現されることの実 UI 検証 (#421)。
 *
 * 純関数側（`site-scope.test.ts`）は解決規則を固定しているが、**実際に URL から読まれて
 * セレクタへ反映されるか**は配線の話なので unit では見えない。第 87 wave で
 * 「純関数は正しいのに配線が stale」という同型の欠陥を踏んでいるため、実ルートで見る。
 *
 * ⚠️ **この 2 本は「回帰ガード」であって、URL 同期が効いていることの証明ではない。**
 * seed の拠点は `default-site` の 1 件だけ（`src/lib/tenant/store.ts`）なので、**URL を
 * 一切見ない旧実装（先頭サイトを自動選択）でも同じ結果になり、両方 pass する**。
 * 「URL から読んでいる」ことを実証するには**2 件目の拠点が要る**。
 *
 * では何を守れるか: 将来 `get('siteId')` を検証せずそのまま採用する実装へ変わった場合、
 * 2 本目（実在しない id）は `no-such-site` が選択されて**落ちる**。安全側の倒し方が
 * 壊れたことは検出できる。
 *
 * 2 件目を作れば切り替えまで実証できるが、共有シードを変えると拠点一覧に依存する他 spec を
 * 不安定にするため、**専用 project への隔離とセット**でないと入れられない
 * （`playwright.config.ts` の FLOW_MUTATING_SPECS と同じ判断）。それは別増分。
 */
test.describe('管理: 拠点スコープが URL に載る (#421)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('URL の siteId が拠点セレクタへ反映される', async ({ page }) => {
    await page.goto('/admin/devices?siteId=default-site');

    const select = page.locator('select').first();
    await expect(select).toHaveValue('default-site');
  });

  test('実在しない siteId は採用せず、実在する拠点へ倒す', async ({ page }) => {
    // ここが安全側の肝。存在しない id をそのまま選択状態にすると、端末一覧が空になり
    // 「この拠点には端末が無い」と**事実と異なる読み方**をされる。
    await page.goto('/admin/devices?siteId=no-such-site');

    const select = page.locator('select').first();
    await expect(select).toHaveValue('default-site');
    // 実在拠点へ倒れているので、一覧は「空」ではなく実データが出る。
    await expect(page.getByText('このサイトに登録された受付端末はありません。')).toHaveCount(0);
  });
});
