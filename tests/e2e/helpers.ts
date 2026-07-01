import { expect, request, type Page } from '@playwright/test';

/**
 * 管理セッションを確立する (issue #24)。
 * page.request は BrowserContext と cookie を共有するため、以降の page.goto も認証済みになる。
 * ローカル/CI では ADMIN_PASSWORD 既定値を使う。
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const res = await page.request.post('/api/admin/login', { data: { password: 'open-reception' } });
  expect(res.ok()).toBeTruthy();
}

/**
 * 受付端末（kiosk）セッションを **エンロール経由で**確立する (issue #239 / #244)。
 *
 * `/kiosk` はセッション必須。`pinRequired=false`（e2e 既定）では PIN 自己許可 API が無効化された
 * ため (#244)、実運用と同じく **管理発行トークンのエンロール**でセッションを得る。
 *
 * 管理操作（ログイン・端末作成・トークン発行）は使い捨ての admin リクエストコンテキストで行い、
 * `page` には kiosk セッション cookie だけを残す（実機の受付端末に管理セッションが乗らないのと同じ）。
 * fullyParallel 下の干渉を避けるため、テストごとに一意な端末を新規作成してエンロールする。
 */
export async function establishKioskSession(page: Page): Promise<void> {
  // request.newContext() は config の use.baseURL を継承しないため明示的に渡す（config と同じ解決）。
  // 空文字 PLAYWRIGHT_BASE_URL を fallback へ倒すため `||` を使う。
  const baseURL =
    process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '') ||
    `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  // ブラウザページを起こさない軽量な APIRequestContext で管理操作を行う（独立 cookie ジャー）。
  const admin = await request.newContext({ baseURL });
  try {
    const login = await admin.post('/api/admin/login', {
      data: { password: 'open-reception' },
    });
    expect(login.ok()).toBeTruthy();

    const created = await admin.post('/api/admin/devices', {
      data: {
        tenantId: 'internal',
        siteId: 'default-site',
        name: `e2e-kiosk-${Math.random().toString(36).slice(2, 9)}`,
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
    expect(token).toBeTruthy();

    // エンロールは page コンテキストで叩き、kiosk_session cookie を page 側へ落とす。
    const enroll = await page.request.post('/api/kiosk/enroll', { data: { token } });
    expect(enroll.ok()).toBeTruthy();
  } finally {
    await admin.dispose();
  }
}
