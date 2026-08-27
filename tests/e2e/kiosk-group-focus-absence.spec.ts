/**
 * 群の先頭が不在でもフォーカスが迷子にならない (#787)。
 *
 * ## なぜ独立した spec ファイルなのか
 *
 * 🔴 **このテストは seed の在席状態をグローバルに書き換える。** `kiosk-touch-first.spec.ts`
 * に置いたところ、`--workers=4` で **3/3 の確率で無関係な受付導線 spec を落とした**
 * （鈴木が不在の 8〜11 秒間に他 spec が `staff-staff-suzuki` を押すと、不在カードは
 * `aria-disabled` の div なので click が黙って no-op になる）。`playwright.config.ts` の
 * `FLOW_MUTATING_KIOSK_SPECS` が**まさにこの型のために**用意されている隔離機構なので、
 * そこへ載せる（単独・直列で走る）。
 *
 * ## なぜ後始末が `afterEach` なのか
 *
 * 🔴 **`finally` では復元されない。** timeout でページが閉じられると `finally` には入るが
 * 中の `await` が即座に reject し、**在席へ戻らないまま run の残り全部が汚染される**
 * （実測）。retry も try の外で先に落ちるので復元しない。Playwright は timeout したテストの
 * 後でも `afterEach` を別枠の時間で走らせるので、後始末はそちらへ置く。
 *
 * ## なぜ seed を触るのか
 *
 * 担当者の新規作成 UI に部署の割当が無く、作った担当者は「その他」の群へ入る。**群の
 * 先頭が不在**という配置を決定的に作れないため、既存の群（開発部）の先頭を不在にする。
 */
import { test, expect, revealStaff } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

const ABSENT_STAFF = '鈴木';

/** 管理 API 用の独立コンテキスト。kiosk の cookie jar に管理セッションを載せない。 */
async function adminPage(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAsAdmin(page);
  await page.goto('/admin/staff');
  return { context, page };
}

async function setAvailability(
  page: import('@playwright/test').Page,
  name: string,
  want: '在席' | '不在',
) {
  const row = page.getByTestId('staff-row').filter({ hasText: name }).first();
  const label = row.getByTestId('staff-availability');
  if ((await label.textContent())?.trim() === want) return;
  await row.getByTestId('staff-availability-toggle').click();
  await expect(label).toHaveText(want);
}

test.afterEach(async ({ browser }) => {
  // 🔴 **timeout で本文が飛んでも必ず戻す。** finally では戻らないことを実測している。
  const { context, page } = await adminPage(browser);
  try {
    await setAvailability(page, ABSENT_STAFF, '在席');
  } finally {
    await context.close();
  }
});

test('群の先頭が不在でもフォーカスは押せる相手へ行く (#787)', async ({ page, browser }) => {
  const { context, page: admin } = await adminPage(browser);
  try {
    await setAvailability(admin, ABSENT_STAFF, '不在');
  } finally {
    await context.close();
  }

  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-takahashi');

  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
    unavailable: document.activeElement?.getAttribute('data-unavailable') ?? null,
  }));
  /*
   * 先頭（鈴木）は不在で押せない。押せる先頭（高橋）へ行く。
   *
   * `not.toBe('BODY')` だけでは弱い —— 戻る導線へのフォールバックがある局面では
   * BODY へ落ちないので、**移動先が誰か**まで見る（独立レビューの指摘）。
   */
  expect(focused.testid, `フォーカスの移動先が想定外: ${JSON.stringify(focused)}`).toBe(
    'staff-staff-takahashi',
  );
  expect(focused.unavailable, '押せないカードへフォーカスした').toBeNull();
});
