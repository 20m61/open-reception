import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * 未保存の変更を持ったまま離脱しようとしたら止める (#912 / 課題 12)。
 *
 * それまで `beforeunload` もルート遷移ガードも **0 件**で、`AdminNav` の
 * `<Link prefetch>` は遷移が即座だった。設定画面で入力の途中にサイドバーを誤って押すと、
 * **確認も警告も無く入力が全部消えていた**。
 */

async function openBranding(page: import('@playwright/test').Page) {
  await loginAsAdmin(page);
  await page.goto('/admin/branding');
  await expect(page.getByTestId('brand-company')).toBeVisible();
}

/**
 * サイドバーの「担当者」へのリンクを押す。
 *
 * iPad の幅（810px）ではサイドバーがドロワーになり、閉じている間は
 * `transform: translateX(-240px)` で**画面の外に居る**（実測: リンクの x が -216）。
 * スクロールでは入ってこないので、実機と同じ手順でハンバーガーを押して開く。
 * 開き切る前に押すと重なりでクリックが奪われるので、`aria-expanded` の反転を待つ。
 *
 * リンクは **href で名指しする** —— `getByRole('link', { name: '担当者' })` は既定が
 * 部分一致なので「担当者応答」にも当たる。
 *
 * `page.goto` で迂回しないのは、いま試したいのが**リンクのクリックを横取りする経路**
 * そのものだから。
 */
async function clickStaffLink(page: import('@playwright/test').Page) {
  const opener = page.getByRole('button', { name: 'メニューを開く' });
  if ((await opener.getAttribute('aria-expanded')) !== 'true') {
    await opener.click();
    await expect(opener).toHaveAttribute('aria-expanded', 'true');
  }
  const link = page.locator('#admin-sidebar a[href="/admin/staff"]');
  await expect(link).toBeInViewport();
  await link.click();
}

test('未保存のままサイドバーを押しても遷移しない', async ({ page }) => {
  await openBranding(page);
  await page.getByTestId('brand-company').fill('未保存の会社名');

  await clickStaffLink(page);

  await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();
  // 画面はまだブランド設定のまま。
  expect(new URL(page.url()).pathname).toBe('/admin/branding');
  await expect(page.getByTestId('brand-company')).toHaveValue('未保存の会社名');
});

test('「移動して変更を破棄」で遷移する', async ({ page }) => {
  await openBranding(page);
  await page.getByTestId('brand-company').fill('捨てる会社名');
  await clickStaffLink(page);
  await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();

  await page.getByTestId('unsaved-changes-leave').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/staff');
});

test('「このページに留まる」で入力が残る', async ({ page }) => {
  await openBranding(page);
  await page.getByTestId('brand-company').fill('残る会社名');
  await clickStaffLink(page);
  await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();

  await page.getByTestId('unsaved-changes-stay').click();
  await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/branding');
  await expect(page.getByTestId('brand-company')).toHaveValue('残る会社名');
});

test('🔴 下界: 未保存の変更が無ければ何も起きない', async ({ page }) => {
  /*
   * 「常に確認する」実装をここで落とす。保護が常時発動すると、読むだけで開いた画面から
   * 出るたびに確認が出て、やがて誰も読まずに押すようになる。
   */
  await openBranding(page);
  await clickStaffLink(page);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/staff');
});

/*
 * 🔴 **#912 で「書けない」と言って外した主張を、#913 でここへ戻した。**
 *
 * ブランド設定は保存前の設定が `{}`（全項目が未設定）で読み込まれる（実測）。入力欄は
 * `value={b.companyName ?? ''}` なので、打って消すと state は「未設定」から `''` へ移る。
 * 素の JSON 比較では別物になるため、**この画面では「元へ戻す」を実演できなかった**。
 * #913 で「未設定」と空文字を同一視したので、実演できるようになった。
 */
test('打って消したら（＝元へ戻したら）保護が下りる (#913)', async ({ page }) => {
  await openBranding(page);
  const input = page.getByTestId('brand-company');

  /*
   * 🔴 **前提を固定する。** この spec が #913 を実演できるのは、会社名が
   * **「未設定」で読み込まれるとき**だけである。将来ここに値が seed されると、
   * 「打って消す」は単なる往復になり、**修正が無くても通る（空虚に通る）**。
   * そうなったら黙って通るのではなく、ここで落ちて気づけるようにしておく。
   */
  expect(await input.inputValue()).toBe('');

  await input.fill('一時的な入力');
  await input.fill('');

  // 見た目が元どおりなら確認は出ない。出るなら遷移が止まってこの poll が落ちる。
  await clickStaffLink(page);
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/staff');
});

test('ダイアログにフォーカス管理がある（#890 の共有フック経由）', async ({ page }) => {
  await openBranding(page);
  await page.getByTestId('brand-company').fill('フォーカス確認');
  await clickStaffLink(page);
  await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();

  // 開いた直後のフォーカスは「留まる」側（誤って Enter を押しても入力が消えない）。
  await expect(page.getByTestId('unsaved-changes-stay')).toBeFocused();

  // Escape で閉じ、留まる。
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/admin/branding');
});
