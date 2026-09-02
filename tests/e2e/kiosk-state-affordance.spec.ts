import { test, expect, type Locator, revealStaff } from './kiosk-fixtures';

// #778 の主対象は iPad landscape。`chromium-ipad` project は名前に反して縦向き
// (810x1080) なので明示する。破線の可読性は視距離が伸びる横向きの方が厳しい。
test.use({ viewport: { width: 1080, height: 810 } });

/**
 * 「押せない」が見て分かるか (#778 AC3)。
 *
 * `.btn:disabled` は長らく `opacity: 0.5` だけで、**E2E も VRT も 1 本も見ていなかった**
 * （無効ボタンを含む画面にベースラインが無い）。透明度だけのボタンは明るいロビーでは
 * 「ただのボタン」に見え、反応しないまま連打される。高コントラストモードではさらに悪く、
 * 透明度は意味を伝えずコントラストだけを削る。
 *
 * 静的テスト（`tests/config/kiosk-state-affordance.test.ts`）は「規則が CSS にある」ことしか
 * 示せない。詳細度負けやセレクタの取り違えで**要素に届かない**可能性があるので、実ブラウザの
 * 計算値で確かめる。
 */

/** 氏名未入力の来訪者情報画面まで進める（`to-confirm` が無効なまま出る唯一の主導線）。 */
async function advanceToVisitorInfo(page: import('@playwright/test').Page) {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
}

function computed(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      opacity: s.opacity,
      borderStyle: s.borderTopStyle,
      borderColor: s.borderTopColor,
      backgroundColor: s.backgroundColor,
      backgroundImage: s.backgroundImage,
      color: s.color,
      cursor: s.cursor,
    };
  });
}

test('無効な主 CTA は透明度ではなく面・枠・文字色で「押せない」を示す (#778 AC3)', async ({ page }) => {
  await advanceToVisitorInfo(page);
  const cta = page.getByTestId('to-confirm');
  await expect(cta).toBeDisabled();

  const off = await computed(cta);
  // 透明度に寄せない。**下げていないこと**まで見る（下げると意味を伝えずコントラストだけ削る）。
  expect(off.opacity).toBe('1');
  // 破線の枠＝押せない、を視覚語彙として持つ。
  expect(off.borderStyle).toBe('dashed');
  // primary の gradient を打ち消してフラットな面に戻っている。
  expect(off.backgroundImage).toBe('none');
  expect(off.cursor).toBe('not-allowed');

  const boxOff = await cta.boundingBox();

  // 有効になったら treatment が外れる（無効表現が居座らない）。
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await expect(cta).toBeEnabled();
  const on = await computed(cta);
  expect(on.borderStyle).not.toBe('dashed');
  expect(on.backgroundImage).not.toBe('none');
  expect(on.color).not.toBe(off.color);

  // 有効化で**寸法が動かない**。枠を太らせて示すと、氏名を打った瞬間にボタンが伸び縮みし、
  // 来訪者は「押せるようになった」ではなく「画面が動いた」と受け取る。
  const boxOn = await cta.boundingBox();
  expect(boxOff).not.toBeNull();
  expect(boxOn).not.toBeNull();
  expect(Math.abs(boxOn!.width - boxOff!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxOn!.height - boxOff!.height)).toBeLessThanOrEqual(1);
});

test('ハイコントラストでも「押せない」の意味が残る (#778 AC5)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('a11y-menu-button').click();
  await page.getByTestId('a11y-contrast-toggle').click();
  await expect(page.locator('main.screen')).toHaveAttribute('data-a11y-contrast', 'high');
  await page.getByTestId('a11y-menu-close').click();

  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  const cta = page.getByTestId('to-confirm');
  await expect(cta).toBeDisabled();

  const off = await computed(cta);
  // 高コントラストでこそ透明度に頼らない（白文字を薄くするのが一番効きが悪い）。
  expect(off.opacity).toBe('1');
  expect(off.borderStyle).toBe('dashed');
  expect(off.backgroundImage).toBe('none');

  // 🔴 ここまでは既定テーマでも同じ値。**ハイコントラストの上書きが死んでも通る**ので、
  // それだけでは AC5 を名乗れない（変数ブロックを消す変異が素通りすることを実測済み）。
  // HC でしか成り立たない計算値まで見る。
  expect(off.backgroundColor, 'HC の --color-surface (#000) が効いていない').toBe('rgb(0, 0, 0)');
  expect(off.color, 'HC の --color-muted (#e6e6e6) が効いていない').toBe('rgb(230, 230, 230)');
});

test('「処理中」は「押せない」と同じ見た目にしない (#792)', async ({ page }) => {
  // `disabled` は条件未達と処理中の 2 つに使われている。#778 の無効表現をそのまま
  // 処理中にも当てると、送信の往復の間だけ主 CTA が破線へ落ち、来訪者は
  // 「押せなくなった／タップが失敗した」と読む。**AC3 を満たすほど悪化する**矛盾。
  //
  // 完了リクエストを遅らせて busy を観測可能な長さに保つ。
  await page.route('**/api/kiosk/receptions/*/complete', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });

  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible({ timeout: 20_000 });

  const finish = page.getByTestId('complete');
  const before = await computed(finish);
  await finish.click();

  // 送信の往復の間。`disabled` は付いたまま（二重送信はブラウザが防ぐ）。
  await expect(finish).toBeDisabled();
  await expect(finish).toHaveAttribute('aria-busy', 'true');
  const busy = await computed(finish);
  expect(busy.borderStyle, '処理中に「押せない」の破線へ落ちている').not.toBe('dashed');
  expect(busy.backgroundColor, '処理中に面が無効表現へ変わっている').toBe(before.backgroundColor);
  // `.btn--secondary` は有効時も無効表現も同じ面色なので、`backgroundColor` だけでは
  // 空振りする。gradient の有無まで見る（primary の主症状はこちら）。
  expect(busy.backgroundImage, '処理中に gradient が消えている').toBe(before.backgroundImage);
  expect(busy.color, '処理中に文字色が無効表現へ変わっている').toBe(before.color);
  expect(busy.cursor, '進行中であることがカーソルに出ていない').toBe('progress');
});

test('別の操作の往復中に、条件未達のボタンが「押せる」見た目へ戻らない (#792 B1)', async ({ page }) => {
  // `busy` を画面共有のフラグのまま `aria-busy` へ流すと、**そのボタン自身の操作でなくても**
  // 進行中表示になり、条件未達で押せないボタンが有効な主 CTA の見た目へ戻る。
  // 退館 QR (`?ct=`) の自動解決中がそれに当たり、空欄の送信ボタン 2 つが該当した。
  // #778 AC3 が防ごうとした「押せないボタンがただのボタンに見える」の再発。
  //
  // 🔴 **往復を保持したまま断定する。** `toHaveAttribute` は自動リトライするので、
  // 遅延させるだけだと「一時的に true → 往復後に false」を待って通してしまう。
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hits = 0;
  await page.route('**/api/kiosk/checkout/resolve', async (route) => {
    hits += 1;
    await held;
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"not_found"}' });
  });

  try {
    await page.goto('/kiosk/checkout?ct=dummy-token');
    const tokenSubmit = page.getByTestId('checkout-token-submit');
    await expect(tokenSubmit).toBeVisible();
    // 検査が空振りしていないこと（自動解決が実際に走って止まっている）。
    await expect.poll(() => hits, { timeout: 10_000 }).toBe(1);

    // 往復は止まったまま。リトライに頼らず 1 度だけ読む。
    await expect(tokenSubmit).toBeDisabled();
    expect(await tokenSubmit.getAttribute('aria-busy')).toBe('false');
    const blocked = await computed(tokenSubmit);
    expect(blocked.borderStyle, '別の操作の往復中に無効表現が外れている').toBe('dashed');
    expect(blocked.backgroundImage, '別の操作の往復中に主 CTA の塗りへ戻っている').toBe('none');
  } finally {
    release?.();
  }
});
