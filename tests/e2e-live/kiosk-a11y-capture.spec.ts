import AxeBuilder from '@axe-core/playwright';
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 実デプロイの受付画面を iPad 横向きで検査し、各画面を撮る。
 *
 * ## 何のためか
 *
 * 実機がすぐ使えない間、**人が目視レビューできる材料**と**機械が判定できる指摘**を出す。
 *
 * - a11y（axe: critical / serious）… コントラスト・アクセシブル名・ARIA。実データ・実配色で
 *   見るので、seed データのローカル検査では出ない指摘が出うる
 * - スクリーンショット … 実機の代わりにはならないが、**文字の詰まり・改行・はみ出し**は分かる
 *
 * ## VRT ではない
 *
 * baseline 比較はしない。実環境のデータは変わるので、差分検知は誤検知だらけになる。
 * ここは「撮って人が見る」ための出力。
 */

const BASE = process.env.LIVE_BASE_URL?.replace(/\/$/, '') ?? '';
const ADMIN_USER = process.env.LIVE_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.LIVE_ADMIN_PASSWORD ?? '';
const OUT = join(process.cwd(), '.live-capture');

test.skip(
  BASE === '' || ADMIN_USER === '' || ADMIN_PASSWORD === '',
  'LIVE_BASE_URL / LIVE_ADMIN_USER / LIVE_ADMIN_PASSWORD が要る',
);

/** 無操作リセット（既定 60 秒）を実行時間より十分長くする。 */
const SLOW_INACTIVITY = '?inactivityMs=600000';

async function issueEnrollmentUrl(api: APIRequestContext): Promise<string> {
  const login = await api.post('/api/admin/login', {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), `admin login failed: ${login.status()}`).toBeTruthy();
  const list = await api.get('/api/admin/kiosks');
  const items = ((await list.json()) as { items: { id: string }[] }).items;
  const kioskId = items[0]?.id ?? '';
  expect(kioskId, '端末が 1 台も無い').toBeTruthy();
  const token = await api.post(`/api/admin/devices/${kioskId}/reissue-token`, {
    data: { tenantId: 'internal' },
  });
  expect(token.ok(), `token issue failed: ${token.status()}`).toBeTruthy();
  return ((await token.json()) as { enrollmentUrl: string }).enrollmentUrl;
}

async function enroll(page: Page): Promise<void> {
  const api = await request.newContext({ baseURL: BASE });
  try {
    await page.goto(await issueEnrollmentUrl(api));
    await page.waitForURL(/\/kiosk(\?|$)/, { timeout: 30_000 }).catch(() => undefined);
    await page.goto(`/kiosk${SLOW_INACTIVITY}`);
    await expect(page.getByTestId('kiosk-idle')).toBeVisible({ timeout: 30_000 });
  } finally {
    await api.dispose();
  }
}

/** critical / serious のみ。それ未満は運用上の優先度が低く、赤の意味を薄める。 */
async function blockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

function summarize(violations: Awaited<ReturnType<typeof blockingViolations>>): string {
  return violations.map((v) => `${v.id}(${v.impact}, nodes=${v.nodes.length})`).join(', ');
}

/** 撮って残す。人が後から見るための出力なので full page で撮る。 */
async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

test('受付ジャーニーの各画面を検査して撮る', async ({ page }) => {
  const findings: string[] = [];

  const check = async (name: string) => {
    await capture(page, name);
    const violations = await blockingViolations(page);
    if (violations.length > 0) findings.push(`${name}: ${summarize(violations)}`);
  };

  await enroll(page);
  await check('01-idle');

  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await check('02-purpose');

  await page.getByTestId('purpose-meeting').click();
  const firstStaff = page.locator('button[data-testid^="staff-staff-"]').first();
  await expect(firstStaff).toBeVisible();
  await check('03-target');

  await firstStaff.click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
  await check('04-visitor-info');

  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
  await check('05-confirm');

  // **1 画面ずつ落とさず、全画面を見てからまとめて報告する。** 最初の 1 件で止めると
  // 「直す → 次が出る」を繰り返すことになり、全体像が分からない。
  expect(findings, `a11y 違反:\n${findings.join('\n')}`).toEqual([]);
});

/**
 * 英語表示でも導線が壊れないこと。kiosk は ja/en/ko/zh 対応 (#103)。
 *
 * **`?lang=en` では切り替わらない。** 最初にそう書いてキャプチャを撮ったが、出てきた画面は
 * 日本語のままで、テストは「日本語画面を見て」通っていた ── **中身の無い検査**だった。
 * 実際のユーザー操作（言語ボタンのタップ）が正しい経路。
 *
 * 切り替わったことを**画面の文字で**確かめる。撮っただけ・通っただけでは、また同じ穴に落ちる。
 */
test('英語へ切り替えると表示が英語になる', async ({ page }) => {
  await enroll(page);
  await capture(page, '10-idle-ja');

  await page.getByRole('button', { name: 'English' }).click();

  // 日本語の見出しが消えていること（＝本当に切り替わったこと）を先に固定する。
  await expect(page.getByText('ご用件をお選びください')).toHaveCount(0);
  await capture(page, '11-idle-en');

  const violations = await blockingViolations(page);
  expect(violations, `英語表示の a11y 違反: ${summarize(violations)}`).toEqual([]);

  // 英語のまま受付を開始できること。
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await capture(page, '12-purpose-en');
});
