import { test, expect } from '@playwright/test';
import { establishKioskSession, loginAsAdmin } from './helpers';

/**
 * admin↔kiosk のテナント統合 E2E (issue #171 inc2)。
 *
 * admin で作成・有効化した受付フローが、受付端末（kiosk セッション）の /api/kiosk/flow に
 * 表示されることを確認する。両者が同じ既定プロビジョニング・スコープ（internal/default-site）
 * を参照することの実データ検証。共有 in-memory ストア汚染を避けるため一意キーで作成する。
 */
function uniq(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
}

// このスペックが既定スコープ（internal/default-site）へ作成した有効フローは、/kiosk セッションゲート
// (issue #239) 導入後は他の kiosk テストの /api/kiosk/flow に漏れ出し既定受付フローの検証を壊す。
// 各テスト後に作成フローを必ず削除し、共有 in-memory バックエンドの汚染を残さない。
const createdFlowIds: string[] = [];

test.afterEach(async ({ page }) => {
  while (createdFlowIds.length) {
    const id = createdFlowIds.pop();
    await page.request
      .delete(`/api/admin/reception-flows/${id}?tenantId=internal&siteId=default-site`)
      .catch(() => {});
  }
});

test('admin で作成・有効化したフローが受付端末の /api/kiosk/flow に出る', async ({ page, browser }) => {
  const key = uniq('e2e-kioskflow');
  const name = uniq('統合フロー');

  // 1) admin で受付フローを作成（既定テナント internal/default-site）。
  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [{ key: 'name', label: 'お名前', type: 'text', required: true }],
    },
  });
  expect(created.ok()).toBeTruthy();
  createdFlowIds.push(((await created.json()) as { id: string }).id);

  // 2) 受付端末セッションを確立する。
  await establishKioskSession(page, browser);

  // 3) 受付端末のフロー一覧に作成したフローが含まれる（有効なフローのみ返る）。
  const res = await page.request.get('/api/kiosk/flow');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { flows: { purposeKey: string; displayName: string }[] };
  expect(body.flows.some((f) => f.purposeKey === key && f.displayName === name)).toBe(true);
});

test('admin で無効化したフローは受付端末に出ない', async ({ page, browser }) => {
  const key = uniq('e2e-disabled');
  const name = uniq('無効フロー');

  await loginAsAdmin(page);
  const created = await page.request.post('/api/admin/reception-flows', {
    data: {
      tenantId: 'internal',
      siteId: 'default-site',
      purposeKey: key,
      displayName: name,
      order: 99,
      steps: ['purpose', 'visitorInfo', 'confirm', 'call'],
      fields: [],
    },
  });
  expect(created.ok()).toBeTruthy();
  const flow = (await created.json()) as { id: string };
  createdFlowIds.push(flow.id);
  // 無効化する。
  const patched = await page.request.patch(`/api/admin/reception-flows/${flow.id}`, {
    data: { tenantId: 'internal', enabled: false },
  });
  expect(patched.ok()).toBeTruthy();

  await establishKioskSession(page, browser);
  const res = await page.request.get('/api/kiosk/flow');
  const body = (await res.json()) as { flows: { purposeKey: string }[] };
  expect(body.flows.some((f) => f.purposeKey === key)).toBe(false);
});
