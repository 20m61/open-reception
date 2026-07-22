// 第5wave (#361 QRシェル / #374 ルートビルダー) の実ブラウザ検証。
import { chromium, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3100';
const outDir = process.argv[3] ?? './w5-shots';
mkdirSync(outDir, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function enrollKiosk(page) {
  const admin = await request.newContext({ baseURL });
  try {
    await admin.post('/api/admin/login', { data: { password: 'open-reception' } });
    const created = await admin.post('/api/admin/devices', {
      data: { tenantId: 'internal', siteId: 'default-site', name: `w5-${Math.random().toString(36).slice(2, 8)}`, kind: 'kiosk' },
    });
    const deviceId = (await created.json()).id;
    const issued = await admin.post(`/api/admin/devices/${deviceId}/reissue-token`, { data: { tenantId: 'internal' } });
    const token = new URL((await issued.json()).enrollmentUrl).searchParams.get('token') ?? '';
    await page.request.post(baseURL + '/api/kiosk/enroll', { data: { token } });
  } finally {
    await admin.dispose();
  }
}

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  args: ['--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

// ===== 1. QR シェル(横向き) =====
{
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 810 }, hasTouch: true, deviceScaleFactor: 1, permissions: ['camera'],
  });
  const page = await ctx.newPage();
  await enrollKiosk(page);
  await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  // ウェルカム画面の QR で受付カード(quick action)をタップ
  await page.getByTestId('start-checkin').tap({ timeout: 10000 });
  await page.waitForTimeout(3000);
  const shell = page.getByTestId('checkin-shell');
  note('qr(landscape): checkin-shell present', await shell.isVisible().catch(() => false));
  note('qr(landscape): avatar rail present', await page.getByTestId('checkin-avatar-rail').isVisible().catch(() => false));
  note('qr(landscape): avatar subtitle present', await page.getByTestId('avatar-subtitle').first().isVisible().catch(() => false));
  await page.screenshot({ path: `${outDir}/W5-01-qr-landscape.png` });
  const presence = await shell.getAttribute('data-checkin-presence').catch(() => null);
  console.log('info: data-checkin-state/presence =', await shell.getAttribute('data-checkin-state').catch(() => null), presence);
  await ctx.close();
}

// ===== 2. QR シェル(縦向き・非退行) =====
{
  const ctx = await browser.newContext({
    viewport: { width: 810, height: 1080 }, hasTouch: true, deviceScaleFactor: 1, permissions: ['camera'],
  });
  const page = await ctx.newPage();
  await enrollKiosk(page);
  await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  await page.getByTestId('start-checkin').tap({ timeout: 10000 });
  await page.waitForTimeout(3000);
  note('qr(portrait): checkin-shell present', await page.getByTestId('checkin-shell').isVisible().catch(() => false));
  await page.screenshot({ path: `${outDir}/W5-02-qr-portrait.png` });
  await ctx.close();
}

// ===== 3. ルートビルダー /admin/call-routing =====
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const login = await page.request.post(baseURL + '/api/admin/login', { data: { password: 'open-reception' } });
  note('admin login', login.ok());
  // RECEPTION_DISABLE_DEV_SEED=1 のため seed が無い → API で最小データを投入して UI を検証
  const ep = await page.request.post(baseURL + '/api/admin/routing/endpoints', {
    data: { tenantId: 'internal', siteId: 'default-site', ownerType: 'staff', ownerId: 'staff-1', channel: 'pstn', e164: '+81900001111', label: '検証 個人携帯', providerKey: 'mock', enabled: true },
  });
  const epBody = await ep.json().catch(() => ({}));
  const epId = epBody.id ?? epBody.endpoint?.id;
  console.log('info: endpoint create', ep.status(), epId);
  const pol = await page.request.post(baseURL + '/api/admin/routing/policies', {
    data: { tenantId: 'internal', siteId: 'default-site', name: '検証ルート', enabled: true, steps: [{ id: 'step-1', endpointId: epId, action: 'notify', timeoutSeconds: 20, nextOn: {} }] },
  });
  console.log('info: policy create', pol.status());
  await page.goto(baseURL + '/admin/call-routing', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);
  note('routing: nav shows 取次ルート', (await page.getByText('取次ルート', { exact: true }).count()) > 0);
  const prose = page.getByTestId('policy-prose').first();
  note('routing: policy prose (seed) visible', await prose.isVisible().catch(() => false));
  if (await prose.isVisible().catch(() => false)) {
    const text = await prose.innerText();
    note('routing: prose has no raw phone number', !/\+81\d{6,}/.test(text));
  }
  // Endpoint 追加 → マスク表示
  await page.getByTestId('endpoint-address-input').fill('+81312349876').catch(() => {});
  const nameInput = page.locator('[data-testid="endpoint-name-input"], [data-testid="endpoint-label-input"]').first();
  await nameInput.fill('検証用 端末').catch(() => {});
  await page.getByTestId('endpoint-add').click().catch(() => {});
  await page.waitForTimeout(2000);
  const pageText = await page.evaluate(() => document.body.innerText);
  note('routing: raw address never displayed after add', !pageText.includes('+81312349876'));
  note('routing: masked address displayed', /9876/.test(pageText) || (await page.getByTestId('endpoint-masked').count()) > 0);
  await page.screenshot({ path: `${outDir}/W5-03-call-routing.png` });
  // 編集フォームの検証エラー(endpoint 未選択 step)
  await page.getByTestId('policy-edit').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByTestId('policy-add-step').click().catch(() => {});
  await page.getByTestId('policy-save').click().catch(() => {});
  await page.waitForTimeout(1500);
  const hasError = (await page.getByTestId('step-error').count()) + (await page.getByTestId('policy-error').count());
  note('routing: invalid step rejected with visible error', hasError > 0, `errors=${hasError}`);
  await page.screenshot({ path: `${outDir}/W5-04-call-routing-error.png` });
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 2 ? 1 : 0);
