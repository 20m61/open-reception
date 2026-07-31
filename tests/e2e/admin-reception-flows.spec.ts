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

// このスペックが既定スコープ（internal/default-site）へ作成した有効フローは、/kiosk セッションゲート
// (issue #239) 導入後は他の kiosk テストの /api/kiosk/flow に漏れ出し既定受付フローの検証を壊す。
// 各テスト後に purposeKey で引いて削除し、共有 in-memory バックエンドの汚染を残さない。
const createdKeys: string[] = [];

async function createFlow(page: Page, key: string, name: string) {
  createdKeys.push(key);
  await page.getByTestId('flow-key-input').fill(key);
  await page.getByTestId('flow-name-input').fill(name);
  await page.getByTestId('flow-add').click();
  await expect(page.getByTestId('flow-card').filter({ hasText: name })).toHaveCount(1);
}

test.afterEach(async ({ page }) => {
  if (!createdKeys.length) return;
  const res = await page.request
    .get('/api/admin/reception-flows?tenantId=internal&siteId=default-site')
    .catch(() => null);
  // 一覧 API は配列を直接返す（{flows} 包みではない）。両形に耐えるよう取り出す。
  const json = res && res.ok() ? await res.json() : [];
  const flows: { id: string; purposeKey: string }[] = Array.isArray(json) ? json : (json.flows ?? []);
  for (const f of flows) {
    if (!createdKeys.includes(f.purposeKey)) continue;
    await page.request
      .delete(`/api/admin/reception-flows/${f.id}?tenantId=internal&siteId=default-site`)
      .catch(() => {});
  }
  createdKeys.length = 0;
});

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

// **「通知ルート割当」の e2e は撤去した (#421 / 移行台帳 §5「取次モデル」)。**
// 画面から割当セレクタを外したため、この導線自体が存在しない。機能を消したことに伴う
// 削除であって、落ちるテストを消して green にしたわけではない。
// 保存済みの callRouteId は API・ドメイン側にまだ残っており、その撤去は後続増分。

test('上下ボタンで隣接フローの並び順を入れ替えられる（永続化される）', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/reception-flows');

  // 末尾に 2 件追加してフローが 2 件以上あることを保証する（seed 数・order 値に依存しない）。
  // **自分が作った 2 件を名前で控える。** flow-mutation project は複数 spec を並行実行
  // するので、「一覧の末尾 2 件」は他 spec のフローになりうるし、検証中に他 spec の
  // afterEach で消えることもある（実際 indexOf が -1 を返して落ちた）。
  const firstName = uniq('並び替えA');
  const secondName = uniq('並び替えB');
  await createFlow(page, uniq('e2e-a'), firstName);
  await createFlow(page, uniq('e2e-b'), secondName);

  const orderOf = async (name: string) =>
    (await page.getByTestId('flow-name').allTextContents()).indexOf(name);

  // 後から作った方（secondName）が下に来ている前提を明示的に確認してから動かす。
  await expect(async () => {
    const a = await orderOf(firstName);
    const b = await orderOf(secondName);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  }).toPass();

  // secondName のカードを上へ移動 → 自分の 2 件の相対順が入れ替わる。
  const lastName = secondName;
  const secondLastName = firstName;
  await page
    .getByTestId('flow-card')
    .filter({ hasText: lastName })
    .getByTestId('flow-move-up')
    .click();
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
