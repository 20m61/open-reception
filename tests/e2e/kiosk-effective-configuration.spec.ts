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

/** 移行対象の個別設定 API（`docs/product-integration-plan.md` §4.1 の 7 行）。 */
const LEGACY_CONFIG_APIS = [
  '/api/kiosk/directory',
  '/api/kiosk/voice',
  '/api/kiosk/assets',
  '/api/kiosk/branding',
  '/api/kiosk/motions',
  '/api/kiosk/flow',
  '/api/kiosk/signage',
];

/** 端末が起動時に叩いた設定 API のパスを記録する。 */
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

  // 待機画面が組み上がるまで待つ（構成取得の完了を UI で観測する）。
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  expect(requests.filter((p) => p === '/api/configuration/effective')).toHaveLength(1);
  expect(requests.filter((p) => LEGACY_CONFIG_APIS.includes(p))).toEqual([]);
});

test('既定（フラグ無し）は新経路を使う（台帳 B-02 で切替）', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  // 既定が新経路になったので、フラグ無しでも実効構成を取りに行く。
  expect(requests).toContain('/api/configuration/effective');
});

test('新経路でも待機画面の文言・目的選択・担当者検索が同じように出る', async ({ page }) => {
  await page.goto('/kiosk?effectiveConfig=1');

  // 音声セクション由来の待機リード文言（旧 /api/kiosk/voice）。
  await expect(page.getByTestId('idle-guidance')).toContainText('タッチ操作だけで受付できます');
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();

  // 受付フローセクション由来: 既定フロー（カスタムフロー未投入）で目的選択へ進む。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  // ディレクトリセクション由来: 担当者検索で seed 担当者が引ける。
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-search')).toBeVisible();
  await page.getByTestId('staff-search').fill('すずき');
  await revealStaff(page, 'staff-staff-suzuki');
  await expect(page.getByTestId('staff-staff-suzuki')).toBeVisible();
});

test('実効構成の取得に失敗したら旧経路へ自動フォールバックする（端末を無設定で放置しない）', async ({
  page,
}) => {
  // 新経路だけを落とす（端末側の切り戻し操作なしで受付が継続できることの確認）。
  await page.route('**/api/configuration/effective*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"section_unavailable"}' }),
  );
  const requests = recordConfigRequests(page);

  await page.goto('/kiosk?effectiveConfig=1');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  // 個別 API へ落ちて構成が揃う（待機リード文言は音声設定由来）。
  await expect(page.getByTestId('idle-guidance')).toContainText('タッチ操作だけで受付できます');
  expect(requests).toContain('/api/kiosk/directory');
  expect(requests).toContain('/api/kiosk/voice');
});

test('新経路は構成を定期的に取り直す（公開した版が端末へ届く経路, #420）', async ({ page }) => {
  const requests = recordConfigRequests(page);
  // `?configSyncMs=` は既存のタイマー上書き（`?inactivityMs=` 等）と同じ E2E 短縮用クエリ。
  await page.goto('/kiosk?effectiveConfig=1&configSyncMs=400');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  // 起動時 1 回だけで終わらず、間隔ごとに取り直している。
  await expect
    .poll(() => requests.filter((p) => p === '/api/configuration/effective').length, {
      timeout: 5000,
    })
    .toBeGreaterThan(2);
  // 再取得は個別 API 経路を呼び戻さない（旧経路へ勝手に落ちない）。
  expect(requests.filter((p) => LEGACY_CONFIG_APIS.includes(p))).toEqual([]);
});

test('受付が進行中の間も取得は続くが、画面は差し替わらない (#420 AC)', async ({ page }) => {
  const requests = recordConfigRequests(page);
  await page.goto('/kiosk?effectiveConfig=1&configSyncMs=400');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();

  // 受付中でも再取得は回る（適用だけを待たせる設計）。
  const before = requests.filter((p) => p === '/api/configuration/effective').length;
  await expect
    .poll(() => requests.filter((p) => p === '/api/configuration/effective').length, {
      timeout: 5000,
    })
    .toBeGreaterThan(before);

  // 来訪者の居る画面は保たれたまま（再取得のたびに待機画面へ戻ったりしない）。
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-search')).toBeVisible();
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
