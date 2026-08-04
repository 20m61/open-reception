import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 実デプロイに対する受付ジャーニーの通し確認（iPad 横向きエミュレーション）。
 *
 * ## 何を確かめるか
 *
 * ローカルの e2e が green でも、実環境では別の理由で壊れる。2026-08-04 の初回検証で
 * **4 件**が見つかった（古い成果物の配布 / OAC が POST を弾く / 管理 API 全 401 /
 * エンロールシークレット未設定）。いずれもローカルでは再現しない。
 *
 * ここで見るのは「**その環境で、その画面サイズで、来訪者が受付を完遂できるか**」。
 *
 * ## 実機の代替ではない
 *
 * 実際の指の当たり、屋内照明での視認性、初見の人がどこで迷うかは埋まらない。
 * 埋まるのは導線が壊れていないことまで。
 */

const BASE = process.env.LIVE_BASE_URL?.replace(/\/$/, '') ?? '';
const ADMIN_USER = process.env.LIVE_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.LIVE_ADMIN_PASSWORD ?? '';

test.skip(
  BASE === '' || ADMIN_USER === '' || ADMIN_PASSWORD === '',
  'LIVE_BASE_URL / LIVE_ADMIN_USER / LIVE_ADMIN_PASSWORD が要る（scripts/e2e-live.sh 参照）',
);

/**
 * 管理者としてログインし、端末エンロール URL を 1 つ発行する。
 *
 * **毎回発行し直す。** トークンは単回使用で 15 分で失効するので、使い回すと 2 回目以降が
 * 必ず落ちる（それは環境の欠陥ではなくテストの欠陥）。
 */
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

  // `tenantId` は必須。省くと 400 になる（実際にこれで詰まった）。
  const token = await api.post(`/api/admin/devices/${kioskId}/reissue-token`, {
    data: { tenantId: 'internal' },
  });
  expect(token.ok(), `token issue failed: ${token.status()}`).toBeTruthy();
  const { enrollmentUrl } = (await token.json()) as { enrollmentUrl: string };
  expect(enrollmentUrl, 'enrollmentUrl が空').toBeTruthy();
  return enrollmentUrl;
}

/**
 * 無操作リセットを実行時間より十分長くする。
 *
 * 既定 60 秒（`INACTIVITY_RESET_MS`）。実環境はレイテンシがあるため、素で流すと
 * **入力途中に「まだご利用中ですか？」のオーバーレイが click を横取りして落ちる**
 * （実際に踏んだ）。これはテストの走り方の問題であって受付の欠陥ではない。
 *
 * 短縮ではなく**延長**なので、`warnMs` の丸め（limit < 10.5 秒で猶予が 500ms 固定になる）
 * には当たらない。
 */
const SLOW_INACTIVITY = '?inactivityMs=600000';

/** エンロールして待機画面まで到達する。 */
async function enroll(page: Page): Promise<void> {
  const api = await request.newContext({ baseURL: BASE });
  try {
    const url = await issueEnrollmentUrl(api);
    await page.goto(url);
    // エンロール後に `/kiosk` へ遷移する。無操作リセットを延長した URL で開き直す。
    await page.waitForURL(/\/kiosk(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
    await page.goto(`/kiosk${SLOW_INACTIVITY}`);
    // エンロール完了後は待機画面へ。ここが出なければ以降は無意味。
    await expect(page.getByTestId('kiosk-idle')).toBeVisible({ timeout: 30_000 });
  } finally {
    await api.dispose();
  }
}

test('受付端末をエンロールし、待機画面が出る', async ({ page }) => {
  await enroll(page);
  // 「受付端末の設定が必要です」が残っていないこと（＝セッションが確立している）。
  await expect(page.getByTestId('kiosk-unenrolled')).toHaveCount(0);
});

/**
 * 来訪者が担当者へ到達できること。J-OR-01 の成功条件そのもの。
 */
test('担当者を検索して発信直前まで進める', async ({ page }) => {
  await enroll(page);

  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await page.getByTestId('purpose-meeting').click();

  // 担当者カードの testid は `staff-<staffId>` で、staffId 自体が `staff-` で始まる
  // （= `staff-staff-xxx`）。`^="staff-"` だと**検索入力 `staff-search` を先に掴んで**
  // クリックが空振りする（実際に踏んだ）。button に限定して曖昧さを消す。
  const firstStaff = page.locator('button[data-testid^="staff-staff-"]').first();
  await expect(firstStaff, '担当者が 0 件（初期データ未投入の可能性）').toBeVisible();
  await firstStaff.click();

  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();

  // **発信直前で相手が分かること** (#591)。ここが空だと同姓同名を確認できない。
  await expect(page.getByTestId('confirm-target')).toBeVisible();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
});

/**
 * 横向き iPad で主要導線が画面内に収まっていること。
 *
 * 受付開始が折り返しの下にあると、初見の来訪者は気づかない。**実機で最も壊れやすいのは
 * レイアウト**なので、サイズ由来の破綻だけでも自動で見る。
 */
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
  // タップ領域（#17 の kiosk UI 基準）。指で押せない大きさなら実機で問題になる。
  expect(box.height, 'タップ領域が小さい').toBeGreaterThanOrEqual(44);
});
