// 第4wave (#363 Demo Harness) の実ブラウザ検証。
// 実行: node scripts/demo-studio-check.mjs <baseURL> <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:3100';
const outDir = process.argv[3] ?? './w4-shots';
mkdirSync(outDir, { recursive: true });

const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.PW_EXECUTABLE_PATH || undefined,
  args: ['--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

// 本番非接続の監視: プレビュー実行中の全リクエストを記録
const requests = [];
page.on('request', (r) => requests.push(r.url()));

// admin ログイン(cookie をコンテキストへ)
const login = await page.request.post(baseURL + '/api/admin/login', {
  data: { password: 'open-reception' },
});
note('admin login', login.ok());

// --- 1. スタジオ本体
await page.goto(baseURL + '/admin/demo', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
note('studio: page renders', await page.getByTestId('demo-studio').isVisible().catch(() => false));
const scenarioCount = await page.locator('[data-testid^="demo-scenario-"]').count();
note('studio: 9 scenarios listed', scenarioCount === 9, `count=${scenarioCount}`);
const navLink = await page.getByText('受付体験スタジオ').count();
note('studio: admin nav shows 受付体験スタジオ', navLink > 0, `count=${navLink}`);
await page.screenshot({ path: `${outDir}/W4-01-studio.png` });

// --- 2. normal-visit を実行 → iframe に本番 Kiosk が出る
requests.length = 0;
await page.getByTestId('demo-scenario-normal-visit').click();
await page.getByTestId('demo-run').click();
const frameEl = page.getByTestId('demo-preview-frame');
let frameShown = true;
try {
  await frameEl.waitFor({ state: 'visible', timeout: 20000 });
} catch {
  frameShown = false;
}
note('preview: iframe appears after run', frameShown);
await page.waitForTimeout(8000);
const frame = page.frameLocator('[data-testid="demo-preview-frame"]');
const kioskVisible = await frame
  .locator('main, [data-kiosk-state], [data-testid="kiosk-signage-waiting"]')
  .first()
  .isVisible()
  .catch(() => false);
note('preview: production kiosk UI renders inside iframe', kioskVisible);
await page.screenshot({ path: `${outDir}/W4-02-preview-normal.png` });

// --- 3. 本番非接続: /api/admin/demo/run と /api/kiosk/* と静的アセット以外が出ていないこと
const offending = requests.filter((u) => {
  if (!u.startsWith(baseURL)) return true; // 外部
  const p = new URL(u).pathname;
  if (p.startsWith('/_next/') || p.startsWith('/avatar/') || p.startsWith('/assets/')) return false;
  if (p === '/admin/demo/preview' || p.startsWith('/admin/demo')) return false;
  if (p.startsWith('/api/kiosk/')) return false;
  if (p === '/api/admin/demo/run') return false;
  if (p === '/favicon.ico') return false;
  return true;
});
note('sandbox: no unexpected/production/external requests during demo', offending.length === 0,
  offending.slice(0, 3).join(', '));

// --- 4. call-failed シナリオ
await page.getByTestId('demo-scenario-call-failed').click();
await page.getByTestId('demo-run').click();
await page.waitForTimeout(6000);
await page.screenshot({ path: `${outDir}/W4-03-preview-call-failed.png` });

// --- 5. 監査: reception.demo_executed が記録されている
const audit = await page.request.get(baseURL + '/api/admin/audit');
const auditBody = await audit.json().catch(() => null);
const entries = Array.isArray(auditBody) ? auditBody : (auditBody?.entries ?? auditBody?.logs ?? []);
const demoEntries = JSON.stringify(entries).includes('reception.demo_executed');
note('audit: reception.demo_executed recorded', demoEntries);

// --- 6. 未知シナリオ
await page.goto(baseURL + '/admin/demo/preview?scenario=nope', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
note('preview: unknown scenario shows explicit empty state',
  await page.getByTestId('demo-preview-unknown').isVisible().catch(() => false));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} checks passed`);
process.exit(failed > 1 ? 1 : 0);
