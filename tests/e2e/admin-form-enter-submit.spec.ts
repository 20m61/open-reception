import { test, expect } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/**
 * admin の CRUD を `<form>` にしたことで **Enter で送信できる** (#892 / 課題 13)。
 *
 * それまで admin の CRUD は `<div>` + `<Button onClick>` で、`<form>` はログイン 2 画面と
 * platform の 3 箇所にしか無かった。入力欄で Enter を押しても何も起きないので、
 * キーボードだけで操作する運用者は 1 件追加するたびに Tab で送信ボタンへ移動していた。
 *
 * ここで見るのは 3 つ。**送信されること**、**ページ遷移しないこと**
 * （`preventDefault` の書き忘れは「動くけれど画面が真っさらになる」形で出る）、
 * そして**下界** —— 送信ボタンが押せない状態では Enter でも送信されないこと。
 * 下界が無いと「Enter で常に送信する」実装（空でも作成してしまう）が素通りする。
 */

function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

test('部署: 入力欄で Enter を押すと追加される', async ({ page }) => {
  const name = uniq('Enter部署');
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-row').first()).toBeVisible();

  const before = page.url();
  await page.getByTestId('dept-name-input').fill(name);
  await page.getByTestId('dept-name-input').press('Enter');

  await expect(page.getByTestId('dept-row').filter({ hasText: name })).toHaveCount(1);
  // `preventDefault` が無いと GET でフォームが送信され、クエリ付き URL へ遷移する。
  expect(page.url()).toBe(before);
});

test('拠点: 入力欄で Enter を押すと追加される', async ({ page }) => {
  const name = uniq('Enter拠点');
  await loginAsAdmin(page);
  await page.goto('/admin/sites');
  await expect(page.getByTestId('site-name-input')).toBeVisible();

  const before = page.url();
  await page.getByTestId('site-name-input').fill(name);
  await page.getByTestId('site-name-input').press('Enter');

  await expect(page.getByTestId('site-saved')).toBeVisible();
  expect(page.url()).toBe(before);
});

test('下界: 送信ボタンが押せないときは Enter でも送信されない', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/departments');
  await expect(page.getByTestId('dept-row').first()).toBeVisible();

  const rowsBefore = await page.getByTestId('dept-row').count();
  const before = page.url();

  // 空のまま Enter。追加ボタンは `name.trim() === ''` で disabled になっている。
  await expect(page.getByTestId('dept-add')).toBeDisabled();
  await page.getByTestId('dept-name-input').press('Enter');

  await expect(page.getByTestId('dept-save-error')).toHaveCount(0);
  await expect(page.getByTestId('dept-row')).toHaveCount(rowsBefore);
  expect(page.url()).toBe(before);
});

test('補足とエラーが入力へ aria-describedby で結ばれている', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/call-routing');

  // 接続先の「表示名」には hint がある。span の id を指していることをブラウザで確かめる。
  const input = page.getByTestId('endpoint-label-input');
  await expect(input).toBeVisible();
  const describedBy = await input.getAttribute('aria-describedby');
  expect(describedBy).toBeTruthy();

  const description = page.locator(`#${describedBy}`);
  await expect(description).toHaveCount(1);
  expect((await description.textContent())?.trim()).not.toBe('');
});

/*
 * #893: 設定画面の「保存」も Enter で送信できる。
 *
 * 追加/作成フォーム（上）とは形が違い、**複数の Field を 1 つの保存ボタンが受ける**。
 * ここでは値を変えずに Enter を押す —— 送信されたことだけを見たいので、
 * 他の spec と競合しうる状態変更を起こさない（保存されるのは読み込んだ値そのもの）。
 */
test('設定: ブランド設定の入力欄で Enter を押すと保存される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/branding');

  const input = page.getByTestId('brand-company');
  await expect(input).toBeVisible();

  const before = page.url();
  await input.press('Enter');

  await expect(page.getByTestId('brand-saved')).toBeVisible();
  expect(page.url()).toBe(before);
});

/*
 * 🔴 サイネージだけは**保存ボタンが `<form>` の外**にある（`Section` の右肩）。
 * ボタンを中へ移すと見た目が変わるので、HTML の `form="signage-form"` で結んでいる。
 * 結び忘れ・id の食い違いは「クリックでは保存できるが Enter では何も起きない」形で出る
 * ので、**Enter 側からしか見えない**。ここが無いとその退行を誰も捕まえられない。
 */
test('設定: サイネージは保存ボタンが form の外にあるが Enter で送信される', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/signage');

  const interval = page.getByTestId('signage-interval');
  await expect(interval).toBeVisible();

  // 送信ボタンが form の外に居ることそのものを固定する（中へ移すと前提が変わる）。
  const save = page.getByTestId('signage-save');
  await expect(save).toHaveAttribute('form', 'signage-form');

  const before = page.url();
  await interval.press('Enter');

  await expect(page.getByTestId('signage-saved')).toBeVisible();
  expect(page.url()).toBe(before);
});
