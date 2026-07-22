// VRM 実描画・状態別表示・.vrma 再生の実ブラウザ検証 (#31 / #65 の headless 可能分)。
// 実行: node .vrm-visual-check.mjs <baseURL> <outDir>
import { chromium, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3100';
const outDir = process.argv[3] ?? './vrm-shots';
mkdirSync(outDir, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function enrollKiosk(page) {
  const admin = await request.newContext({ baseURL });
  try {
    const login = await admin.post('/api/admin/login', { data: { password: 'open-reception' } });
    if (!login.ok()) throw new Error('admin login failed');
    const created = await admin.post('/api/admin/devices', {
      data: {
        tenantId: 'internal',
        siteId: 'default-site',
        name: `vrm-check-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'kiosk',
      },
    });
    const deviceId = (await created.json()).id;
    const issued = await admin.post(`/api/admin/devices/${deviceId}/reissue-token`, {
      data: { tenantId: 'internal' },
    });
    const { enrollmentUrl } = await issued.json();
    const token = new URL(enrollmentUrl).searchParams.get('token') ?? '';
    const enroll = await page.request.post(baseURL + '/api/kiosk/enroll', { data: { token } });
    if (!enroll.ok()) throw new Error('enroll failed: ' + enroll.status());
  } finally {
    await admin.dispose();
  }
}

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  args: ['--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({
  viewport: { width: 810, height: 1080 },
  deviceScaleFactor: 1,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await enrollKiosk(page);
await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });

// --- 1. VRM canvas がプレースホルダの代わりに現れるか
const canvas = page.getByTestId('vrm-canvas');
let canvasShown = true;
try {
  await canvas.waitFor({ state: 'visible', timeout: 60000 });
} catch {
  canvasShown = false;
}
note('vrm: canvas visible (VRM enabled, not placeholder)', canvasShown);

if (canvasShown) {
  // モデル読込 + 初回描画待ち(SwiftShader は遅い)
  await page.waitForTimeout(12000);

  // --- 2. 実際に描画されているか(黒/空でない): canvas 要素のスクショの画素分散
  const shot1 = await canvas.screenshot();
  const stats1 = await sharp(shot1).stats();
  const maxStd = Math.max(...stats1.channels.map((c) => c.stdev));
  note('vrm: canvas has non-blank pixels (model rendered)', maxStd > 8, `max stdev=${maxStd.toFixed(1)}`);
  await sharp(shot1).toFile(`${outDir}/vrm-01-idle.png`);

  // --- 3. 手続き的アイドル(呼吸)で動いているか: 2.5 秒空けて差分
  await page.waitForTimeout(2500);
  const shot2 = await canvas.screenshot();
  await sharp(shot2).toFile(`${outDir}/vrm-02-idle-2.5s.png`);
  note('vrm: idle animation moves the model (frames differ)', !shot1.equals(shot2));

  await page.screenshot({ path: `${outDir}/vrm-03-idle-full.png` });

  // --- 4. 受付を開始し状態遷移後もアバターが生きているか(表情/ポーズは目視)
  const start = page.getByTestId('signage-start').or(page.locator('main'));
  await page.touchscreen.tap(405, 540);
  await page.waitForTimeout(4000);
  const canvasAfter = await page.getByTestId('vrm-canvas').count();
  note('vrm: canvas survives state transition to reception', canvasAfter > 0, `count=${canvasAfter}`);
  await page.screenshot({ path: `${outDir}/vrm-04-purpose-full.png` });

  // --- 5. motionUrl 属性(状態別モーション接続口)の確認
  if (canvasAfter > 0) {
    const motionUrl = await page.getByTestId('vrm-canvas').first().getAttribute('data-motion-url');
    console.log('info: data-motion-url =', JSON.stringify(motionUrl));
  }

  // --- 6. 自作 idle.vrma を default motion に割り当て、実再生を検証 (#31)
  const admin = await request.newContext({ baseURL });
  try {
    await admin.post('/api/admin/login', { data: { password: 'open-reception' } });
    const created = await admin.post('/api/admin/assets', {
      data: { kind: 'motion', name: 'idle(自作 vrma)', url: '/avatar/idle.vrma' },
    });
    const body = await created.json();
    const assetId = body.id ?? body.value?.id;
    note('vrma: motion asset registered', created.ok() && !!assetId, `id=${assetId}`);
    const put = await admin.put('/api/admin/motions', { data: { default: assetId } });
    note('vrma: assigned as default motion', put.ok());

    await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const canvas2 = page.getByTestId('vrm-canvas');
    await canvas2.waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForTimeout(12000);
    const mu = await canvas2.getAttribute('data-motion-url');
    note('vrma: kiosk resolves motion url', mu === '/avatar/idle.vrma', `data-motion-url=${mu}`);
    const m1 = await canvas2.screenshot();
    await sharp(m1).toFile(`${outDir}/vrm-05-vrma-playing.png`);
    const mstats = await sharp(m1).stats();
    const mstd = Math.max(...mstats.channels.map((c) => c.stdev));
    note('vrma: canvas rendered during playback', mstd > 8, `max stdev=${mstd.toFixed(1)}`);
    await page.waitForTimeout(2500);
    const m2 = await canvas2.screenshot();
    await sharp(m2).toFile(`${outDir}/vrm-06-vrma-playing-2.5s.png`);
    note('vrma: motion animates the model (frames differ)', !m1.equals(m2));
    // 後始末(割り当て解除)
    await admin.put('/api/admin/motions', { data: { default: null } });
  } finally {
    await admin.dispose();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
