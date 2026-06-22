import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 来訪目的別カスタム受付フロー管理の E2E (issue #100, increment 2)。
 * 共有 in-memory ストア汚染を避けるため、seed は触らず一意キーで新規作成・操作する。
 * purposeKey は小文字英数+ハイフンのみ許可されるため、トークンも小文字で生成する。
 */
function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createFlow(page: Page, key: string, name: string) {
  await page.getByTestId('flow-key-input').fill(key);
  await page.getByTestId('flow-name-input').fill(name);
  await page.getByTestId('flow-add').click();
  await expect(page.getByTestId('flow-card').filter({ hasText: name })).toHaveCount(1);
}

test('カスタムフローを作成し、選択肢付きの入力項目を追加できる（永続化される）', async ({ page }) => {
  const key = uniq('e2e-flow');
  const name = uniq('面接フロー');
  await loginAsAdmin(page);
  await page.goto('/admin/reception-flows');
  await createFlow(page, key, name);

  const card = page.getByTestId('flow-card').filter({ hasText: name });
  // select 型の入力項目を追加する。
  await card.getByTestId('flow-field-key').fill('slot');
  await card.getByTestId('flow-field-label').fill('希望枠');
  await card.getByTestId('flow-field-type').selectOption('select');
  await card.getByTestId('flow-field-options').fill('午前, 午後');
  await card.getByTestId('flow-field-required').check();
  await card.getByTestId('flow-field-add').click();

  // 追加した項目が表示される。
  await expect(card.getByTestId('flow-field').filter({ hasText: '希望枠' })).toHaveCount(1);

  // 再読込しても永続している（PATCH fields が保存された）。
  await page.reload();
  const reloaded = page.getByTestId('flow-card').filter({ hasText: name });
  await expect(reloaded.getByTestId('flow-field').filter({ hasText: '希望枠' })).toHaveCount(1);
});

test('受付フローに通知ルートを割り当てて永続化できる（#100）', async ({ page }) => {
  const key = uniq('e2e-route');
  const name = uniq('ルート割当フロー');
  await loginAsAdmin(page);
  await page.goto('/admin/reception-flows');
  await createFlow(page, key, name);

  const card = page.getByTestId('flow-card').filter({ hasText: name });
  const select = card.getByTestId('flow-call-route');
  // 既定は未割当。
  await expect(select).toHaveValue('');

  // 選択肢にある実ルート（value が空でない最初の option）を割り当てる。
  const routeValue = await select
    .locator('option')
    .evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== ''),
    );
  expect(routeValue, '通知ルートのシードが必要').toBeTruthy();
  await select.selectOption(routeValue!);

  // 再読込しても割り当てが永続している（PATCH callRouteId が保存された）。
  await page.reload();
  const reloaded = page.getByTestId('flow-card').filter({ hasText: name });
  await expect(reloaded.getByTestId('flow-call-route')).toHaveValue(routeValue!);
});

test('上下ボタンで隣接フローの並び順を入れ替えられる（永続化される）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/reception-flows');

  // 末尾に 2 件追加してフローが 2 件以上あることを保証する（seed 数・order 値に依存しない）。
  await createFlow(page, uniq('e2e-a'), uniq('並び替えA'));
  await createFlow(page, uniq('e2e-b'), uniq('並び替えB'));

  const orderOf = async (name: string) =>
    (await page.getByTestId('flow-name').allTextContents()).indexOf(name);

  // 末尾 2 件（必ず隣接）の名前を控える。
  const cards = page.getByTestId('flow-card');
  const count = await cards.count();
  const namesBefore = await page.getByTestId('flow-name').allTextContents();
  const lastName = namesBefore[count - 1];
  const secondLastName = namesBefore[count - 2];
  expect(lastName).not.toBe(secondLastName);

  // 末尾カードを上へ移動 → 末尾 2 件が入れ替わる。
  await cards.nth(count - 1).getByTestId('flow-move-up').click();
  await expect(async () => {
    expect(await orderOf(lastName)).toBeLessThan(await orderOf(secondLastName));
  }).toPass();

  // 再読込しても並びが永続する（クライアント再フェッチ完了を待ってから検証する）。
  await page.reload();
  await expect(page.getByTestId('flow-card').filter({ hasText: lastName })).toBeVisible();
  await expect(async () => {
    expect(await orderOf(lastName)).toBeLessThan(await orderOf(secondLastName));
  }).toPass();
});
