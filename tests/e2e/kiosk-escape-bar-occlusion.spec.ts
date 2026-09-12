import { test, expect, revealStaff, type Page } from './kiosk-fixtures';
import { establishKioskSession } from './helpers';

/**
 * 逃げ道バーが内容を覆っているときだけ「まだ続きがある」を出す (#816 / #1057)。
 *
 * スクリーンショットでは遮蔽とレイアウト終端を区別できないため、`elementsFromPoint` で
 * バー直下の実内容を測る。No Typing 化後は文字検索で本文を縮めず、部署群の開閉で
 * 同じ「scroll/resize を伴わない本文寸法変化」を作る。
 */
const IPAD_97_LANDSCAPE = { width: 1024, height: 768 } as const;

test.use({ viewport: IPAD_97_LANDSCAPE, deviceScaleFactor: 1, reducedMotion: 'reduce' });

const MORE = 'escape-bar-scroll-more';

async function openTargetSelection(page: Page): Promise<void> {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function measureOcclusion(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.kiosk-escape-bar');
    if (!bar) return null;
    const barRect = bar.getBoundingClientRect();
    const y = barRect.top + 2;
    const hidden: string[] = [];
    let depth = 0;
    for (let i = 1; i <= 5; i += 1) {
      const x = barRect.left + (barRect.width * i) / 6;
      for (const el of document.elementsFromPoint(x, y)) {
        if (bar.contains(el) || el.contains(bar)) continue;
        if (window.getComputedStyle(el).position === 'fixed') continue;
        hidden.push(el.getAttribute('data-testid') ?? `${el.tagName}.${el.className}`);
        depth = Math.max(depth, el.getBoundingClientRect().bottom - barRect.top);
        break;
      }
    }
    return {
      barTop: Math.round(barRect.top),
      barHeight: Math.round(barRect.height),
      occludedDepth: Math.round(depth),
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      scrollY: Math.round(window.scrollY),
      hiddenUnderBar: hidden,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await establishKioskSession(page);
});

test('上界: 初期着地でバーが内容を覆っていれば「まだ続きがある」を出す (1024x768)', async ({
  page,
}) => {
  await openTargetSelection(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

  const m = await measureOcclusion(page);
  expect(m, 'バーが描画されている').not.toBeNull();
  expect(m!.pageScroll, '相手選択は 1024x768 でスクロールする').toBeGreaterThan(0);
  expect(m!.hiddenUnderBar.length, 'バーの下に内容が潜っている').toBeGreaterThan(0);
  await expect(page.getByTestId(MORE)).toBeVisible();

  // EscapeBar の実測高さがチャット FAB の安全余白へ渡っていることも縛る (#121 H1)。
  const chatSafeBottom = await page.evaluate(() => {
    const slot = document.querySelector('.kiosk-chat-slot');
    const bar = document.querySelector('.kiosk-escape-bar');
    if (!slot || !bar) return null;
    return {
      value: window.getComputedStyle(slot).getPropertyValue('--kiosk-chat-safe-bottom').trim(),
      expected: `${bar.getBoundingClientRect().height + 16}px`,
    };
  });
  expect(chatSafeBottom, 'チャットスロットと逃げ道バーが在る').not.toBeNull();
  expect(chatSafeBottom!.value).toBe(chatSafeBottom!.expected);
});

test('下界: スクロールし切って覆いが無くなったら消える', async ({ page }) => {
  await openTargetSelection(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await expect(page.getByTestId(MORE)).toBeVisible();

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);

  const after = await measureOcclusion(page);
  expect(after!.hiddenUnderBar, 'スクロール末端ではバーは何も覆っていない').toEqual([]);
  await expect(page.getByTestId(MORE)).toHaveCount(0);
});

test('上界: 覆いが始まった瞬間（バーの高さより浅い）から出す', async ({ page }) => {
  await openTargetSelection(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  await expect(page.getByTestId(MORE)).toHaveCount(0);

  const STEP = 4;
  let m = await measureOcclusion(page);
  let steps = 0;
  while (m!.hiddenUnderBar.length === 0 && steps < 60) {
    await page.evaluate((d) => window.scrollBy(0, -d), STEP);
    await page.waitForTimeout(40);
    m = await measureOcclusion(page);
    steps += 1;
  }

  expect(steps, '戻していくうちに覆いが始まる').toBeGreaterThan(0);
  expect(m!.hiddenUnderBar.length, '覆いが始まった').toBeGreaterThan(0);
  expect(m!.occludedDepth, '覆いはバーの高さより浅い').toBeLessThan(m!.barHeight / 2);
  await expect(page.getByTestId(MORE)).toBeVisible();
});

test('下界: そもそもスクロールしない画面では、バーが在っても出さない', async ({ page }) => {
  await page.goto('/kiosk?callingStageMs=100&callingNoticeMs=200&callingNoticeHoldMs=100');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-suzuki');
  await page.getByTestId('staff-staff-suzuki').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await page.getByTestId('use-fallback').click();
  await expect(page.getByTestId('fallback')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const m = await measureOcclusion(page);
  expect(m, 'この画面にも逃げ道バーは在る').not.toBeNull();
  expect(m!.pageScroll, '代替案内は 1024x768 に収まる').toBeLessThanOrEqual(0);
  expect(m!.hiddenUnderBar, 'バーは何も覆っていない').toEqual([]);

  const companion = await page.evaluate(() => {
    const bar = document.querySelector('.kiosk-escape-bar');
    const el = document.querySelector('.kiosk-avatar-companion');
    if (!bar || !el) return null;
    return {
      position: window.getComputedStyle(el).position,
      bottom: Math.round(el.getBoundingClientRect().bottom),
      barTop: Math.round(bar.getBoundingClientRect().top),
    };
  });
  expect(companion, 'アバターコンパニオンが描画されている').not.toBeNull();
  expect(companion!.position).toBe('fixed');
  expect(companion!.bottom).toBeGreaterThan(companion!.barTop);
  await expect(page.getByTestId(MORE)).toHaveCount(0);
});

/**
 * 下界（本文が縮んだ）: scroll/resize 無しで本文寸法だけが変わる経路。
 * 旧テストの「検索で1件へ絞る」を、No Typing の「部署群→小さい担当者群」に置換する。
 */
test.describe('本文が縮む経路（縦に余裕のある viewport）', () => {
  test.use({ viewport: { width: 1024, height: 1000 } });

  test('下界: 部署群から担当者群へ開いて覆いが消えたら、スクロールしなくても消える', async ({
    page,
  }) => {
    await openTargetSelection(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    const before = await measureOcclusion(page);
    expect(before!.hiddenUnderBar.length, '群を開く前は覆っている').toBeGreaterThan(0);
    await expect(page.getByTestId(MORE)).toBeVisible();

    // 文字検索ではなく、担当者1名程度の小さい部署群を開いて本文を縮める。
    await revealStaff(page, 'staff-staff-sato');
    await page.waitForTimeout(500);

    const after = await measureOcclusion(page);
    expect(after!.scrollY, 'スクロールしていない').toBe(0);
    expect(after!.hiddenUnderBar, 'バーは何も覆っていない').toEqual([]);
    await expect(page.getByTestId(MORE)).toHaveCount(0);
  });
});

test.describe('チャットスロットが空の画面（縦を詰めた viewport）', () => {
  test.use({ viewport: { width: 1024, height: 600 } });

  test('上界: 完了画面（チャットスロットが display:none）でも覆いを見つける', async ({
    page,
  }) => {
    await page.goto('/kiosk?callingStageMs=100&callingNoticeMs=200&callingNoticeHoldMs=100');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('purpose-meeting').click();
    await revealStaff(page, 'staff-staff-sato');
    await page.getByTestId('staff-staff-sato').click();
    await page.getByTestId('visitor-name').fill('来客 一郎');
    await page.getByTestId('to-confirm').click();
    await page.getByTestId('confirm-call').click();
    await expect(page.getByTestId('result-connected')).toBeVisible();
    await page.getByTestId('complete').click();
    await expect(page.getByTestId('completed')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);

    const slot = await page.evaluate(() => {
      const el = document.querySelector('.kiosk-chat-slot');
      if (!el) return { present: false, display: 'absent' };
      return { present: true, display: window.getComputedStyle(el).display };
    });
    expect(slot.display, 'この画面ではチャットスロットが数えられない').not.toBe('flex');

    const m = await measureOcclusion(page);
    expect(m, 'この画面にも逃げ道バーは在る').not.toBeNull();
    expect(m!.hiddenUnderBar.length, 'バーの下に内容が潜っている').toBeGreaterThan(0);
    await expect(page.getByTestId(MORE)).toBeVisible();
  });
});
