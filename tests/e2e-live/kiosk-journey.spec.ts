import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 実デプロイに対する受付ジャーニーの通し確認（iPad 横向きエミュレーション）。
 * ローカル E2E では拾えない配布・認証・実環境レイテンシまで含めて、来訪者が受付を
 * 完遂できるかを見る。実機の指当たり/視認性/初見迷いの代替ではない。
 */
const BASE = process.env.LIVE_BASE_URL?.replace(/\/$/, '') ?? '';
const ADMIN_USER = process.env.LIVE_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.LIVE_ADMIN_PASSWORD ?? '';

test.skip(
  BASE === '' || ADMIN_USER === '' || ADMIN_PASSWORD === '',
  'LIVE_BASE_URL / LIVE_ADMIN_USER / LIVE_ADMIN_PASSWORD が要る（scripts/e2e-live.sh 参照）',
);

async function issueEnrollmentUrl(api: APIRequestContext): Promise<string> {
  const login = await api.post('/api/admin/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), `admin login failed: ${login.status()}`).toBeTruthy();

  const list = await api.get('/api/admin/kiosks');
  expect(list.ok(), `kiosk list failed: ${list.status()}`).toBeTruthy();
  const items = ((await list.json()) as { items: { id: string }[] }).items;

  const kioskId =
    items[0]?.id ??
    ((await (await api.post('/api/admin/kiosks', { data: { displayName: 'e2e-live' } })).json()) as {
      id: string;
    }).id;

  const token = await api.post(`/api/admin/devices/${kioskId}/reissue-token`, {
    data: { tenantId: 'internal' },
  });
  expect(token.ok(), `token issue failed: ${token.status()}`).toBeTruthy();
  const { enrollmentUrl } = (await token.json()) as { enrollmentUrl: string };
  expect(enrollmentUrl, 'enrollmentUrl が空').toBeTruthy();
  return enrollmentUrl;
}

const SLOW_INACTIVITY = '?inactivityMs=600000';

async function enroll(page: Page): Promise<void> {
  const api = await request.newContext({ baseURL: BASE });
  try {
    const url = await issueEnrollmentUrl(api);
    await page.goto(url);
    await page.waitForURL(/\/kiosk(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
    await page.goto(`/kiosk${SLOW_INACTIVITY}`);
    await expect(page.getByTestId('kiosk-idle')).toBeVisible({ timeout: 30_000 });
  } finally {
    await api.dispose();
  }
}

/**
 * No Typing の段階開示から、実在する最初の押せる担当者へ到達する。
 * 部署が1群だけのときはビュー側が群選択を飛ばすので、その形も許容する。
 */
async function chooseFirstAvailableStaff(page: Page): Promise<void> {
  await expect(page.getByTestId('staff-search')).toHaveCount(0);

  const directStaff = page.locator('button[data-testid^="staff-staff-"]').first();
  if (await directStaff.isVisible().catch(() => false)) {
    await directStaff.click();
    return;
  }

  const groups = page.locator('button[data-testid^="staff-group-"][data-selectable]');
  const count = await groups.count();
  expect(count, '担当者の部署群が 0 件（初期データ未投入の可能性）').toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const group = page.locator('button[data-testid^="staff-group-"][data-selectable]').nth(i);
    const selectable = Number((await group.getAttribute('data-selectable')) ?? '0');
    if (selectable <= 0) continue;
    await group.click();
    const firstStaff = page.locator('button[data-testid^="staff-staff-"]').first();
    if (await firstStaff.isVisible().catch(() => false)) {
      await firstStaff.click();
      return;
    }
    await page.getByTestId('staff-group-back').click();
  }
  throw new Error('押せる担当者がどの部署にも見つかりませんでした');
}

test('受付端末をエンロールし、待機画面が出る', async ({ page }) => {
  await enroll(page);
  await expect(page.getByTestId('kiosk-unenrolled')).toHaveCount(0);
});

/** 来訪者が software keyboard 無しで担当者へ到達できること。J-OR-01 の成功条件。 */
test('担当者をタッチで選んで発信直前まで進める', async ({ page }) => {
  await enroll(page);

  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await page.getByTestId('purpose-meeting').click();

  await chooseFirstAvailableStaff(page);
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();

  await expect(page.getByTestId('confirm-target')).toBeVisible();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
});

test('横向きで受付開始がファーストビューに収まる', async ({ page }) => {
  await enroll(page);

  const start = page.getByTestId('start-reception');
  await expect(start).toBeVisible();

  const box = await start.boundingBox();
  expect(box, '受付開始の位置を取得できない').not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;

  expect(box.y + box.height, '受付開始がファーストビューに収まっていない').toBeLessThanOrEqual(
    viewport.height,
  );
  expect(box.height, 'タップ領域が小さい').toBeGreaterThanOrEqual(44);
});
