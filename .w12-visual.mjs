import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const outDir = process.argv[2];
mkdirSync(outDir, { recursive: true });
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 170_000);
const results = [];
const note = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH });
const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 } });
await ctx.request.post('http://127.0.0.1:3100/api/admin/login', { data: { password: 'devpass' } });
const req = ctx.request;

// --- 1. 部署復唱の新文言(voice-department-visit)
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:3100/admin/demo/preview?scenario=voice-department-visit', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.locator('button:has-text("担当者を呼ぶ")').first().click();
await page.waitForTimeout(800);
await page.locator('button:has-text("面会")').first().click();
let readbackText = '';
for (let i = 0; i < 50; i++) {
  const rb = page.getByTestId('voice-readback');
  if (await rb.count()) { readbackText = (await rb.first().innerText({ timeout: 300 }).catch(() => '')).trim(); if (readbackText) break; }
  await page.waitForTimeout(200);
}
note('dept readback: no 様 suffix', readbackText.length > 0 && !readbackText.includes('様'), readbackText.slice(0, 40));
await page.screenshot({ path: `${outDir}/01-dept-readback.png` });

// staff 側は従来どおり「様」
const p2 = await ctx.newPage();
await p2.goto('http://127.0.0.1:3100/admin/demo/preview?scenario=voice-staff-visit', { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(1000);
await p2.locator('button:has-text("担当者を呼ぶ")').first().click();
await p2.waitForTimeout(800);
await p2.locator('button:has-text("面会")').first().click();
let staffRb = '';
for (let i = 0; i < 50; i++) {
  const rb = p2.getByTestId('voice-readback');
  if (await rb.count()) { staffRb = (await rb.first().innerText({ timeout: 300 }).catch(() => '')).trim(); if (staffRb) break; }
  await p2.waitForTimeout(200);
}
note('staff readback: keeps 様', staffRb.includes('様'), staffRb.slice(0, 40));

// --- 2. 営業状態の自動切替(ポーリング): open で /kiosk 表示 → API で closed 保存 → リロードなしで切替
// 営業時間: 全曜日空(=保存すると常時 closed)ではなく、まず「現在 open」を保存
const now = new Date(Date.now() + 9 * 3600 * 1000); // JST
const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const today = dayKeys[now.getUTCDay()];
await req.put('http://127.0.0.1:3100/api/admin/operating-policy', {
  data: { tenantId: 'internal', siteId: 'default-site', weeklySchedule: { [today]: [{ start: '00:00', end: '23:59' }] } },
});
const kiosk = await ctx.newPage();
await kiosk.goto('http://127.0.0.1:3100/kiosk', { waitUntil: 'domcontentloaded' });
await kiosk.waitForTimeout(1500);
const before = await kiosk.getByTestId('kiosk-out-of-hours').count();
note('polling: open state shows normal screen', before === 0);
// closed へ更新(今日を営業なしに)
await req.put('http://127.0.0.1:3100/api/admin/operating-policy', {
  data: { tenantId: 'internal', siteId: 'default-site', weeklySchedule: {} },
});
// ポーリング(60s)を待つ… 検証時間短縮のため最大 75 秒待つ
let switched = false;
for (let i = 0; i < 25; i++) {
  if (await kiosk.getByTestId('kiosk-out-of-hours').count()) { switched = true; break; }
  await kiosk.waitForTimeout(3000);
}
note('polling: switches to OutOfHours without reload', switched);
await kiosk.screenshot({ path: `${outDir}/02-auto-switch.png` });

// --- 3. checkin 字幕の言語切替(英語で QR 導線)
const en = await ctx.newPage();
await en.goto('http://127.0.0.1:3100/admin/demo/preview?scenario=qr-checkin-valid', { waitUntil: 'domcontentloaded' });
await en.waitForTimeout(900);
await en.locator('button:has-text("English")').first().click().catch(() => {});
await en.waitForTimeout(500);
await en.locator('button:has-text("QR")').first().click().catch(() => {});
await en.waitForTimeout(900);
const enText = await en.locator('body').innerText({ timeout: 1000 }).catch(() => '');
note('checkin i18n: English text appears', /QR|check[- ]?in|camera|start/i.test(enText) && !/カメラの使用を許可/.test(enText), (enText.match(/[A-Za-z][^\n]{10,50}/) ?? [''])[0]);
await en.screenshot({ path: `${outDir}/03-checkin-en.png` });

console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
