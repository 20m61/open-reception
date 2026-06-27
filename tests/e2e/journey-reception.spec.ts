import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * フラッグシップ・シナリオテスト（docs/customer-journeys.md J2→J3→J4）。
 *
 * 理想ジャーニーを横断でシミュレートする:
 *   テナント管理者が受付URL/QR を発行 → 受付端末がそのURLでエンロール → 来訪者が受付して
 *   担当者に接続 → 完了して待機へ復帰。
 *
 * ロールごとに別ブラウザコンテキスト（管理者の PC と現場の iPad は別物）を使う。
 * 端末状態（enrollmentTokenId）は in-memory 共有のため、各テストは **専用の Device を新規作成**して
 * シード端末（kiosk-dev）の取り合いを避ける（fullyParallel 下での干渉防止）。
 */
const TENANT = 'internal';
const SITE = 'default-site';

/** 管理 API で一意な受付端末を作成し、その id を返す。 */
async function createDevice(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/api/admin/devices', {
    data: { tenantId: TENANT, siteId: SITE, name, kind: 'kiosk' },
  });
  expect(res.ok()).toBeTruthy();
  const device = (await res.json()) as { id: string };
  expect(device.id).toBeTruthy();
  return device.id;
}

/** 管理 API で受付URLを発行する（堅牢性テスト用・UI を介さない）。 */
async function issueUrlViaApi(request: APIRequestContext, deviceId: string): Promise<string> {
  const res = await request.post(`/api/admin/devices/${deviceId}/reissue-token`, {
    data: { tenantId: TENANT },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { enrollmentUrl: string };
  expect(body.enrollmentUrl).toContain('/kiosk/enroll?token=');
  return body.enrollmentUrl;
}

/** 管理 UI（J2 の実画面）で対象端末の受付URLを発行し、その URL を返す。 */
async function issueUrlViaUi(admin: Page, deviceName: string): Promise<string> {
  await admin.goto('/admin/devices');
  const row = admin.getByTestId('device-table').locator('tr', { hasText: deviceName });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByTestId('device-reissue').click();

  await expect(admin.getByTestId('device-reissue-dialog')).toBeVisible();
  await admin.getByTestId('device-reissue-confirm').click();

  await expect(admin.getByTestId('device-issued-dialog')).toBeVisible();
  await expect(admin.getByTestId('device-issued-qr')).toBeVisible();
  const url = await admin.getByTestId('device-issued-url').inputValue();
  expect(url).toContain('/kiosk/enroll?token=');
  return url;
}

/** 受付端末として URL を開き、待機画面に到達することを確認する（J3）。 */
async function enrollAndExpectIdle(device: Page, url: string): Promise<void> {
  await device.goto(url);
  await expect(device.getByTestId('start-reception')).toBeVisible({ timeout: 20_000 });
  await expect(device).toHaveURL(/\/kiosk(\?.*)?$/);
}

test.describe('理想ジャーニー: 発行→エンロール→受付→担当者接続', () => {
  test('管理者が発行した受付URLで端末が稼働し、来訪者が担当者に繋がる', async ({ browser }) => {
    // 横断ジャーニー（作成→UI発行→エンロール→受付→接続）は手数が多いため長めに取る。
    test.setTimeout(90_000);
    const adminCtx = await browser.newContext();
    const deviceCtx = await browser.newContext();
    try {
      const name = `J-flagship-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const url = await test.step('J2: 管理者が受付URLをUIで発行', async () => {
        const admin = await adminCtx.newPage();
        await loginAsAdmin(admin);
        await createDevice(admin.request, name);
        return issueUrlViaUi(admin, name);
      });

      const device = await deviceCtx.newPage();
      await test.step('J3: 端末がエンロールして待機画面へ', async () => {
        await enrollAndExpectIdle(device, url);
      });

      await test.step('J4: 来訪者が受付を開始し、担当者に接続', async () => {
        await device.getByTestId('start-reception').click();

        // 受付の用件選択面が出る（端末が稼働し受付を開始できる）。受付フロー構成により
        // 既定の用件ボタン or カスタム用件画面（#100）のどちらかになる（共有サーバの構成依存）。
        const purposeMeeting = device.getByTestId('purpose-meeting');
        const customView = device.getByTestId('custom-purpose-view');
        await expect(purposeMeeting.or(customView).first()).toBeVisible({ timeout: 15_000 });

        if (await purposeMeeting.isVisible()) {
          // 既定フロー: 来訪者が担当者（staff-sato=connected で決定的）に接続するまで通す。
          await purposeMeeting.click();
          await device.getByTestId('staff-staff-sato').click();
          await device.getByTestId('visitor-name').fill('来客 太郎');
          await device.getByTestId('to-confirm').click();
          await expect(device.getByTestId('confirm-call')).toBeVisible({ timeout: 10_000 });
          await device.getByTestId('confirm-call').click();
          await expect(device.getByTestId('result-connected')).toBeVisible({ timeout: 20_000 });
        } else {
          // カスタム受付フロー構成時は、接続詳細は reception-flow.spec が担保するため、
          // ここではエンロール端末が受付を開始できることを確認する。
          await expect(customView).toBeVisible();
        }
      });
    } finally {
      await adminCtx.close();
      await deviceCtx.close();
    }
  });
});

test.describe('理想ジャーニーの堅牢性: 単回URL / 再起動復帰 / 失効', () => {
  test('発行済みURLは一度だけ使え、別端末での使い回しは弾かれる（単回性）', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const firstDeviceCtx = await browser.newContext();
    const secondDeviceCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await loginAsAdmin(admin);
      const id = await createDevice(admin.request, `J-single-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      const url = await issueUrlViaApi(admin.request, id);

      // 1台目は正常にエンロール。
      await enrollAndExpectIdle(await firstDeviceCtx.newPage(), url);

      // 2台目（別コンテキスト=セッション無し）が同じ URL を開くと使用済みで弾かれる。
      const second = await secondDeviceCtx.newPage();
      await second.goto(url);
      await expect(second.getByTestId('enroll-error')).toBeVisible({ timeout: 15_000 });
      await expect(second.getByText('既に使用されています')).toBeVisible();
    } finally {
      await adminCtx.close();
      await firstDeviceCtx.close();
      await secondDeviceCtx.close();
    }
  });

  test('エンロール済み端末は再訪（再起動相当）でも締め出されず待機へ復帰', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const deviceCtx = await browser.newContext();
    try {
      const admin = await adminCtx.newPage();
      await loginAsAdmin(admin);
      const id = await createDevice(admin.request, `J-reboot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      const url = await issueUrlViaApi(admin.request, id);
      const device = await deviceCtx.newPage();

      // 初回エンロール。
      await enrollAndExpectIdle(device, url);

      // 同じ URL を再訪（ブックマーク再起動相当）。セッション保持を検知し再消費せず待機へ。
      await device.goto(url);
      await expect(device.getByTestId('start-reception')).toBeVisible({ timeout: 15_000 });
      await expect(device.getByTestId('enroll-error')).toHaveCount(0);
    } finally {
      await adminCtx.close();
      await deviceCtx.close();
    }
  });

  test('無効なトークンのURLは安全に弾かれ、再発行を案内する', async ({ page }) => {
    await page.goto('/kiosk/enroll?token=not-a-valid-token');
    await expect(page.getByTestId('enroll-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('enroll-retry')).toBeVisible();
  });
});
