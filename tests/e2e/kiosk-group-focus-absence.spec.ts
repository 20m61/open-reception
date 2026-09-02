/**
 * 群の先頭が不在でもフォーカスが迷子にならない (#787 / #817)。
 *
 * ## なぜ独立した spec ファイルなのか
 *
 * 🔴 **このテストは seed の在席状態をグローバルに書き換える。** `kiosk-touch-first.spec.ts`
 * に置いたところ、`--workers=4` で **3/3 の確率で無関係な受付導線 spec を落とした**
 * （鈴木が不在の 8〜11 秒間に他 spec が `staff-staff-suzuki` を押すと、不在カードは
 * `aria-disabled` の div なので click が黙って no-op になる）。
 *
 * 🔴 **既存の `flow-mutation-kiosk` へ相乗りさせるのでは足りない。** `fullyParallel` は
 * config 全体に効くので**同じ project の中でも並行実行される**。実際そこへ載せたところ、
 * 同居する `kiosk-flow-integration` が作るカスタムフローで組込みの `purpose-meeting` が
 * DOM から消え、**4 回中 2 回タイムアウトした**（`retries` が吸収して緑のままだった）。
 * よって `staff-availability-mutation` という**専用の終端 project**へ隔離してある ——
 * 直列だから安全なのではなく、**同居者が 0 だから**安全である。
 *
 * ⚠️ **このファイルに 2 本目を足すときは `test.describe.serial` を巻くこと。** 足した瞬間に
 * 自分同士が並行し、両方が同じ担当者の在席を奪い合う。#817 で 2 本目を足したので巻いてある。
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
 * 「全員不在」も同じ群の残り（高橋）を不在にして作る (#817)。
 */
import { test, expect, revealStaff } from './kiosk-fixtures';
import { loginAsAdmin } from './helpers';

/** 開発部の先頭。#787 の「押せる相手へ逃げる」ケースで不在にする。 */
const FIRST_STAFF = '鈴木';
/** 開発部のもう 1 人。#817 の「押せる相手が 0」ケースで二人とも不在にする。 */
const SECOND_STAFF = '高橋';
const DEV_GROUP = 'staff-group-dept-dev';

/** 管理 API 用の独立コンテキスト。kiosk の cookie jar に管理セッションを載せない。 */
async function adminPage(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAsAdmin(page);
    await page.goto('/admin/staff');
    return { context, page };
  } catch (error) {
    // ここで投げると呼び出し側の close へ到達しない。ワーカー終了まで context が残る。
    await context.close();
    throw error;
  }
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

async function focusedOn(page: import('@playwright/test').Page) {
  return page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
    unavailable: document.activeElement?.getAttribute('data-unavailable') ?? null,
  }));
}

test.describe.serial('群を開いたときのフォーカス (#787 / #817)', () => {
  test.afterEach(async ({ browser }) => {
    // 🔴 **timeout で本文が飛んでも必ず戻す。** finally では戻らないことを実測している。
    // 2 本が同じ担当者を触るので、後始末は両方を在席へ戻す（片方だけだと次の本が前提を失う）。
    const { context, page } = await adminPage(browser);
    try {
      await setAvailability(page, FIRST_STAFF, '在席');
      await setAvailability(page, SECOND_STAFF, '在席');
    } finally {
      await context.close();
    }
  });

  test('群の先頭が不在でもフォーカスは押せる相手へ行く (#787)', async ({ page, browser }) => {
    const { context, page: admin } = await adminPage(browser);
    try {
      /*
       * 🔴 **前提を主張してから変える。** `setAvailability` は希望状態なら早期 return するので、
       * これが無いと**鈴木が既に不在だった世界**（前回の後始末が失敗した等）を検出できない。
       */
      await expect(
        admin.getByTestId('staff-row').filter({ hasText: FIRST_STAFF }).first().getByTestId('staff-availability'),
        '前提が崩れている: 開始時点で在席でない',
      ).toHaveText('在席');
      await setAvailability(admin, FIRST_STAFF, '不在');
    } finally {
      await context.close();
    }

    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-takahashi');

    const focused = await focusedOn(page);
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

  test('全員不在の群を開いたらフォーカスは部署を選び直すへ退避する (#817)', async ({
    page,
    browser,
  }) => {
    const { context, page: admin } = await adminPage(browser);
    try {
      await expect(
        admin.getByTestId('staff-row').filter({ hasText: FIRST_STAFF }).first().getByTestId('staff-availability'),
        '前提が崩れている: 鈴木が開始時点で在席でない',
      ).toHaveText('在席');
      await expect(
        admin.getByTestId('staff-row').filter({ hasText: SECOND_STAFF }).first().getByTestId('staff-availability'),
        '前提が崩れている: 高橋が開始時点で在席でない',
      ).toHaveText('在席');
      await setAvailability(admin, FIRST_STAFF, '不在');
      await setAvailability(admin, SECOND_STAFF, '不在');
    } finally {
      await context.close();
    }

    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await expect(page.getByTestId('staff-groups')).toBeVisible();
    // 押せる相手が 0 でも群カードは残る（営業時間外は全部署がこの形）。開いて退避を踏む。
    await page.getByTestId(DEV_GROUP).click();
    await expect(page.getByTestId('staff-group-back')).toBeVisible();

    /*
     * `?? groupBackRef.current` を削除すると、押せる相手が居ないので focus() が
     * no-op になり、群カードが消えたあとフォーカスは BODY へ落ちる（#787 レビュー実測）。
     * 移動先が「戻る」であることまで見る。`not.toBe('BODY')` だけでは、たまたま
     * 不在カードの div に残っても通る。
     */
    await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'staff-group-back');
    const focused = await focusedOn(page);
    expect(focused.testid).toBe('staff-group-back');
    expect(focused.tag).toBe('BUTTON');
  });
});
