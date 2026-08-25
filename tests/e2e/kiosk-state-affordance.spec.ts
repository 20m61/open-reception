import { test, expect, type Locator } from './kiosk-fixtures';

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
