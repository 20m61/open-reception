import { test, expect, revealStaff } from './kiosk-fixtures';

/**
 * 実効構成の一括取得へ切り替えた受付端末の E2E (issue #422 increment 1 / #419)。
 *
 * 移行フラグ `?effectiveConfig=1` を付けると、端末は個別設定 API 7 本
 * （directory / voice / assets / branding / motions / flow / signage）ではなく
 * `GET /api/configuration/effective` の 1 回取得で構成を組み立てる。ここで固定するのは:
 *
 *   1. 新経路では個別設定 API を**叩かない**（二重取得になっていない）
 *   2. 新経路でも受付導線が同じ表示・同じ遷移で成立する（既存機能の維持）
 *   3. 旧経路（フラグ無し）は無変更
 *   4. 新経路が失敗したら旧経路へ自動フォールバックし、端末が無設定で固まらない
 *
 * 端末実行のスコープはサーバがセッション束縛から解決するため、URL に tenant/site/kiosk は
 * 付けない（付けても無視される。`src/domain/product-context/context.ts`）。
 */

const LEGACY_CONFIG_APIS = [
  '/api/kiosk/directory',
  '/api/kiosk/voice',
  '/api/kiosk/assets',
  '/api/kiosk/branding',
  '/api/kiosk/motions',
  '/api/kiosk/flow',
  '/api/kiosk/signage',
];

function recordConfigRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (LEGACY_CONFIG_APIS.includes(path) || path === '/api/configuration/effective') {
      seen.push(path);
    }
  });
  return seen;
}

test('新経路では実効構成を 1 回だけ取得し、個別設定 API を叩かない', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk?effectiveConfig=1');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  expect(requests.filter((p) => p === '/api/configuration/effective')).toHaveLength(1);
  expect(requests.filter((p) => LEGACY_CONFIG_APIS.includes(p))).toEqual([]);
});

test('既定（フラグ無し）は新経路を使う（台帳 B-02 で切替）', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  expect(requests).toContain('/api/configuration/effective');
});

test('新経路でも待機・目的選択・No Typing担当者選択が同じ構成から成立する', async ({ page }) => {
  await page.goto('/kiosk?effectiveConfig=1');

  await expect(page.getByTestId('idle-guidance')).toContainText('タッチ操作だけで受付できます');
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();

  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  // ディレクトリセクション由来: seed 担当者へ software keyboard 無しで到達できる。
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await revealStaff(page, 'staff-staff-suzuki');
  await expect(page.getByTestId('staff-staff-suzuki')).toBeVisible();
});

test('実効構成の取得に失敗したら旧経路へ自動フォールバックする（端末を無設定で放置しない）', async ({
  page,
}) => {
  await page.route('**/api/configuration/effective*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"section_unavailable"}' }),
  );
  const requests = recordConfigRequests(page);

  await page.goto('/kiosk?effectiveConfig=1');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  await expect(page.getByTestId('idle-guidance')).toContainText('タッチ操作だけで受付できます');
  expect(requests).toContain('/api/kiosk/directory');
  expect(requests).toContain('/api/kiosk/voice');
});

test('新経路は構成を定期的に取り直す（公開した版が端末へ届く経路, #420）', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk?effectiveConfig=1&configSyncMs=400');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  await expect
    .poll(() => requests.filter((p) => p === '/api/configuration/effective').length, {
      timeout: 5000,
    })
    .toBeGreaterThan(2);
  expect(requests.filter((p) => LEGACY_CONFIG_APIS.includes(p))).toEqual([]);
});

test('受付が進行中の間も取得は続くが、画面は差し替わらない (#420 AC)', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk?effectiveConfig=1&configSyncMs=400');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  const before = requests.filter((p) => p === '/api/configuration/effective').length;
  await expect
    .poll(() => requests.filter((p) => p === '/api/configuration/effective').length, {
      timeout: 5000,
    })
    .toBeGreaterThan(before);

  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
});

/**
 * **旧経路は撤去（台帳 B-03）まで生きている**ので、明示的な切り戻しの検査を残す。
 * これが落ちたら、撤去前に退避経路が壊れているということ。
 */
test('?effectiveConfig=0 で端末 1 台だけ旧経路へ切り戻せる', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk?effectiveConfig=0');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  expect(requests).not.toContain('/api/configuration/effective');
  expect(requests).toContain('/api/kiosk/directory');
});
