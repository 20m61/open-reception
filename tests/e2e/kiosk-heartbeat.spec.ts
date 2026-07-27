import { request } from '@playwright/test';
import { test, expect } from './kiosk-fixtures';

/**
 * 受付端末 heartbeat の E2E (issue #30)。
 * 端末有効性・許可状態を返し、長期表示中の変化を検知できることを確認する。
 */

/** config の baseURL と同じ解決（`request.newContext()` は use.baseURL を継承しない）。 */
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '') ||
  `http://127.0.0.1:${process.env.PORT ?? 3000}`;

test('有効端末の heartbeat は active=true（端末 ID を送らなくてもセッションから解決する, #419）', async ({
  page,
}) => {
  const res = await page.request.get('/api/kiosk/heartbeat');
  expect(res.ok()).toBeTruthy();
  const hb = (await res.json()) as { active: boolean; serverTime: string };
  expect(hb.active).toBe(true);
  expect(typeof hb.serverTime).toBe('string');
});

test('未登録端末の heartbeat は active=false（セッション無しはクエリで判定する）', async () => {
  // kiosk セッションを持たない素のコンテキストで叩く。セッションが在ると端末 ID はそちらが
  // 権威になるため (#419)、未登録端末の検証はセッション無しで行う必要がある。
  const anonymous = await request.newContext({ baseURL });
  try {
    const res = await anonymous.get('/api/kiosk/heartbeat?kioskId=unknown-device');
    const hb = (await res.json()) as { active: boolean; authorized: boolean };
    expect(hb.active).toBe(false);
    expect(hb.authorized).toBe(false);
  } finally {
    await anonymous.dispose();
  }
});

test('エンロール済み端末の heartbeat が死活を更新する（#419 / #261）', async () => {
  // 旧実装ではクライアントが `kiosk-dev` 固定値を送っており、セッションの kioskId
  // （ランダム UUID）と食い違うため**記録がまるごとスキップ**されていた。
  // エンロール自体も lastSeenAt を立てるので、「値が在ること」では不足で、
  // **heartbeat で値が進むこと**を測る。
  const admin = await request.newContext({ baseURL });
  const device = await request.newContext({ baseURL });
  try {
    expect((await admin.post('/api/admin/login', { data: { password: 'open-reception' } })).ok())
      .toBeTruthy();
    const created = await admin.post('/api/admin/devices', {
      data: {
        tenantId: 'internal',
        siteId: 'default-site',
        name: `e2e-heartbeat-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'kiosk',
      },
    });
    expect(created.ok()).toBeTruthy();
    const deviceId = ((await created.json()) as { id: string }).id;

    const issued = await admin.post(`/api/admin/devices/${deviceId}/reissue-token`, {
      data: { tenantId: 'internal' },
    });
    expect(issued.ok()).toBeTruthy();
    const { enrollmentUrl } = (await issued.json()) as { enrollmentUrl: string };
    const token = new URL(enrollmentUrl).searchParams.get('token') ?? '';
    expect((await device.post('/api/kiosk/enroll', { data: { token } })).ok()).toBeTruthy();

    const read = async () => {
      const res = await admin.get(`/api/admin/devices/${deviceId}?tenantId=internal`);
      expect(res.ok()).toBeTruthy();
      return (await res.json()) as { lastSeenAt?: string };
    };
    const before = (await read()).lastSeenAt;

    // 端末 ID を送らない heartbeat（実クライアントと同じ形）。セッションから解決されるはず。
    expect((await device.get('/api/kiosk/heartbeat')).ok()).toBeTruthy();

    await expect.poll(async () => (await read()).lastSeenAt, { timeout: 5000 }).not.toBe(before);
  } finally {
    await admin.dispose();
    await device.dispose();
  }
});

test('エンロール済み端末の heartbeat は authorized が true（#239/#244）', async ({ page }) => {
  // フィクスチャがエンロールで kiosk セッションを確立済み。heartbeat がそれを authorized で反映する。
  const res = await page.request.get('/api/kiosk/heartbeat');
  const hb = (await res.json()) as { authorized: boolean };
  expect(hb.authorized).toBe(true);
});

test('受付端末は heartbeat 稼働中も待機画面を表示し続ける', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('start-reception')).toBeVisible();
  // オフライン表示は出ていない（通信正常）。
  await expect(page.getByTestId('kiosk-offline')).toHaveCount(0);
});
