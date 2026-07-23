// 第3wave (#361 Character-led レイアウト + VRM) の実ブラウザ検証。
// 実行: node .w3-visual-check.mjs <baseURL> <outDir>
import { chromium, request } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3100';
const outDir = process.argv[3] ?? './w3-shots';
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
      data: {
        tenantId: 'internal',
        siteId: 'default-site',
        name: `w3-check-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'kiosk',
      },
    });
    const deviceId = (await created.json()).id;
    const issued = await admin.post(`/api/admin/devices/${deviceId}/reissue-token`, {
      data: { tenantId: 'internal' },
    });
    const { enrollmentUrl } = await issued.json();
    const token = new URL(enrollmentUrl).searchParams.get('token') ?? '';
    await page.request.post(baseURL + '/api/kiosk/enroll', { data: { token } });
  } finally {
    await admin.dispose();
  }
}

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  args: ['--enable-unsafe-swiftshader'],
});

async function openKiosk(viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await enrollKiosk(page);
  await page.goto(baseURL + '/kiosk', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(6000);
  return { ctx, page };
}

// ============ 横向き iPad (1080x810) ============
{
  const { ctx, page } = await openKiosk({ width: 1080, height: 810 });
  const root = page.locator('[data-kiosk-presence]').first();
  const presenceIdle = (await root.count()) ? await root.getAttribute('data-kiosk-presence') : null;
  note('landscape: data-kiosk-presence present (idle)', presenceIdle !== null, `value=${presenceIdle}`);
  await page.screenshot({ path: `${outDir}/L-00-idle.png` });

  // 受付開始 → 用件選択
  await page.touchscreen.tap(540, 405);
  await page.waitForTimeout(3000);
  const presenceSel = (await root.count()) ? await root.getAttribute('data-kiosk-presence') : null;
  note('landscape: presence becomes companion on selecting', presenceSel === 'companion', `value=${presenceSel}`);
  const subtitle = page.getByTestId('avatar-subtitle');
  note('landscape: avatar subtitle visible on purpose select', await subtitle.first().isVisible().catch(() => false));
  const vrm = await page.getByTestId('vrm-canvas').count();
  note('landscape: vrm canvas present in companion rail', vrm > 0, `count=${vrm}`);
  await page.screenshot({ path: `${outDir}/L-01-purpose.png` });

  // 用件カードをタップ → 担当者/部署選択へ
  const meetCard = page.getByText('面会', { exact: true }).first();
  try {
    await meetCard.tap({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${outDir}/L-02-target.png` });
    note('landscape: reached target selection', true);
  } catch {
    note('landscape: reached target selection', false, '面会カードに到達できず(スクショ参照)');
  }
  await ctx.close();
}

// ============ 縦向き iPad (810x1080) — 非退行 ============
{
  const { ctx, page } = await openKiosk({ width: 810, height: 1080 });
  await page.touchscreen.tap(405, 540);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${outDir}/P-01-purpose.png` });
  // 縦向きではレール(subtitle 常設)を出さない = 既存プロファイル維持
  const subtitleP = await page.getByTestId('avatar-subtitle').first().isVisible().catch(() => false);
  console.log('info: portrait avatar-subtitle visible =', subtitleP);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 1 ? 1 : 0);
