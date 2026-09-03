import { test, expect, revealStaff, type Page } from './kiosk-fixtures';
import { establishKioskSession } from './helpers';

/**
 * 逃げ道バーが内容を覆っているときだけ「まだ続きがある」を出す (#816)。
 *
 * ## なぜ VRT ではなくヒットテストなのか
 *
 * スクリーンショットでは「カードが少し切れている」としか見えず、**それが覆いなのか
 * レイアウトの終わりなのか機械的に区別できない**。#787 の独立レビューが実測したのは
 * 1024x768（iPad 9.7"/mini 横向き相当）の相手選択で、最下段の群カードが `bottom 713` に
 * 対しバー `top 658` で **55px 潜っていた**という座標の関係である。ここでも同じく、
 * `elementsFromPoint` で**バーの下に実際に何が居るか**を直接測る。
 *
 * ## なぜ「余白を足す」で解けないのか
 *
 * バーは `.screen` の**最後の in-flow 子**なので、内容の下に余白を足すと**バーがその分
 * 下がるだけ**で相対関係は変わらない（#787 の 3 周目が実測し、追加した `padding-bottom` は
 * 名指しした遮蔽を 1px も直していなかった）。塞ぐのではなく提示する。
 *
 * ## 上界と下界
 *
 * 上界（隠れていれば出す）だけでは「常に出す」で空虚に通る。**下界**として
 * 「スクロールし切った位置」「そもそもスクロールしない画面」「本文が縮んで覆いが消えた」
 * の 3 つを併せて縛る。
 *
 * ## この spec が拠っている実測値（1024x768・相手選択）
 *
 * | 位置 | バー上端 | 本文下端 | 覆い |
 * | --- | --- | --- | --- |
 * | 初期着地 `scrollY=0` | 652 | 971 | あり（群カードが潜る） |
 * | スクロール末端 `scrollY=407` | 612 | 588 | なし（バーは viewport 下端から 40px 浮く） |
 *
 * 🔴 **末端でバーは viewport 下端に付いていない。** `.screen` の下余白ぶん浮く（実測 40px）。
 * さらに本文の終端はバー上端の 24px 上にある。したがって「末端から少し戻す」だけでは
 * 覆いは始まらない —— **戻し量を決め打ちにせず、覆いが始まるまで少しずつ戻す。**
 */

/** #816 が実測した viewport（iPad 9.7" / mini 横向き相当）。 */
const IPAD_97_LANDSCAPE = { width: 1024, height: 768 } as const;

test.use({ viewport: IPAD_97_LANDSCAPE, deviceScaleFactor: 1, reducedMotion: 'reduce' });

const MORE = 'escape-bar-scroll-more';

/** 相手選択（縦に長い画面）まで進める。 */
async function openTargetSelection(page: Page): Promise<void> {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/**
 * バーの下に潜っている内容を実測する。
 *
 * サンプル点は**バーの上端のすぐ内側**に取る。バーの縦中央で測ると、バーの高さより浅い
 * 覆い（#816 が名指しした「最下段が少しだけ切れて見える」形）を取りこぼす。
 *
 * `elementsFromPoint` の列から除くのは 3 種類:
 * バー自身とその子孫 / バーの祖先（`.screen` 等は常に下に居る）/ `position: fixed` の
 * 重なり（チャット FAB・アバターコンパニオンは「流れの中の内容」ではない）。
 */
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
      /** バー上端より下に出ている内容の深さ（＝覆われている高さ）。 */
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
  // 前提: この viewport で相手選択はスクロールする。ここが 0 になったらテストは
  // 「覆いが無い」ことを見ているだけになり、上界の主張が空虚になる。
  expect(m!.pageScroll, '相手選択は 1024x768 でスクロールする').toBeGreaterThan(0);
  // 前提の実体: バーの下に実際に内容が潜っている（座標の関係として確認する）。
  expect(m!.hiddenUnderBar.length, 'バーの下に内容が潜っている').toBeGreaterThan(0);

  await expect(page.getByTestId(MORE)).toBeVisible();

  /*
   * 🔴 **外から渡された ref が生きていること**を併せて縛る (#121 H1)。
   *
   * #816 の測定のために `EscapeBar` は ref を 1 つに統一した（呼び出し側の ref へ代入すると
   * React Compiler の `react-hooks/immutability` が error にするため）。統一を誤って
   * 内部 ref だけを使うと、`KioskFlow` の `escapeBarRef` に node が入らず
   * `--kiosk-chat-safe-bottom` が既定値のまま残り、**チャット FAB がバーに重なる**
   * ——「押せると思って押したら別の操作が発火する」型の欠陥である。
   * 変異検証でこの取り違えが生存したので、ここで塞ぐ。
   */
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
  expect(
    chatSafeBottom!.value,
    '逃げ道バーの実測高さがチャット FAB の持ち上げ量へ渡っている',
  ).toBe(chatSafeBottom!.expected);
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

/**
 * 上界（浅い覆い）: **覆いが始まった最初の瞬間**に、もう出ている。
 *
 * 🔴 これが無いと、判定の基準点をバー**上端**から**下端**へ取り違えても全テストが通る
 * （変異検証で実測）。深く潜っている画面ではどちらの基準でも「覆っている」になるため、
 * 上の上界テストは基準点を区別できない。下端を基準にすると**バーの高さ（実測 116px）
 * 未満の覆いを全部取りこぼす** —— それはまさに #816 が名指しした欠陥そのものである。
 */
test('上界: 覆いが始まった瞬間（バーの高さよりはるかに浅い）から出す', async ({ page }) => {
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
  // 「浅い」ことをその場で実測する。ここが barHeight 以上なら、この test は浅い覆いを
  // 見ていないので基準点の取り違えを区別できない。
  expect(m!.occludedDepth, '覆いはバーの高さよりはるかに浅い').toBeLessThan(m!.barHeight / 2);

  await expect(page.getByTestId(MORE)).toBeVisible();
});

test('下界: そもそもスクロールしない画面では、バーが在っても出さない', async ({ page }) => {
  /*
   * 代替案内画面（#325）を使う。CTA を持たず逃げ道バーだけの画面で、この viewport に
   * 余裕をもって収まる。**バー自体は出ている**ので、ここで出ないことは
   * 「バーが無いから」ではなく「覆っていないから」である。
   *
   * 🔴 あわせて **`position: fixed` の兄弟を内容と数えていない**ことを実画面で押さえる。
   * `.kiosk-avatar-companion` はこの画面に出ており、viewport の**左下**（実測 bottom=768）
   * に居る。素朴に「バーより前の兄弟の下端」を取る実装だと、覆いがゼロのこの画面でも
   * 出しっぱなしになる。純関数側は `contentBottomOf` の単体テストで縛ってあるが、
   * **配線が実際にその除外を通しているか**はここでしか見えない。
   */
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

  // fixed の兄弟が「バーより下」に実在することを確かめてから、出ないことを主張する
  // （居ないなら、この下界は fixed の除外を何も検証していない）。
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
  expect(
    companion!.bottom,
    'コンパニオンはバー上端より下に居る（除外しないと誤検知する配置）',
  ).toBeGreaterThan(companion!.barTop);

  await expect(page.getByTestId(MORE)).toHaveCount(0);
});

/**
 * 下界（本文が縮んだ）: **スクロールも resize も起きずに**覆いが消える経路。
 *
 * 🔴 `KioskFlow` が #788 で踏んだのと同じ形。担当者を検索で絞ると一覧が縮んで覆いが
 * 消えるが、`scrollY` は 0 のままなので **scroll も resize も発火しない**。バー自身の
 * 寸法も変わらないので `ResizeObserver`（バーのみ）でも捕まらない。本文を観測して
 * いないと、覆いが消えた後も提示が出しっぱなしになる（変異検証で実測）。
 *
 * 1024x768 では絞り込んでもまだ覆いが残る（実測 11px）ので、**縦に余裕のある viewport**
 * を使う。ここで見たいのは画面サイズではなく「本文が縮む経路」そのものである。
 */
test.describe('本文が縮む経路（縦に余裕のある viewport）', () => {
  test.use({ viewport: { width: 1024, height: 1000 } });

  test('下界: 検索で本文が縮んで覆いが消えたら、スクロールしなくても消える', async ({
    page,
  }) => {
    await openTargetSelection(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    const before = await measureOcclusion(page);
    expect(before!.hiddenUnderBar.length, '絞り込む前は覆っている').toBeGreaterThan(0);
    await expect(page.getByTestId(MORE)).toBeVisible();

    // 一致を絞って一覧を縮める。**スクロール位置は 0 のまま動かさない。**
    await page.getByTestId('staff-search').fill('鈴木');
    await page.waitForTimeout(500);

    const after = await measureOcclusion(page);
    expect(after!.scrollY, 'スクロールしていない').toBe(0);
    expect(after!.hiddenUnderBar, 'バーは何も覆っていない').toEqual([]);
    await expect(page.getByTestId(MORE)).toHaveCount(0);
  });
});

/**
 * 上界（チャットスロットが空の画面）: **バーの直前の兄弟だけを見ていては足りない。**
 *
 * 🔴 `.kiosk-chat-slot` は `deriveChatAvailability` が `unavailable` を返す局面
 * （`idle` / `cancelled` / `completed`）で `:empty` により `display: none` になる。
 * このとき「バーの直前の兄弟」は**数えられない要素**で、その 1 つ前は `position: fixed` の
 * アバターコンパニオン —— **本文（`.screen-anim`）は 3 つ前にある**。
 * 直前の 1 つで打ち切る実装だと、この画面では「内容が測れない」となり、覆っていても
 * 出さなくなる（変異検証で実測）。完了画面は退館 QR（#342）を載せるので縦に長い。
 *
 * 縦を詰めた viewport を使うのは、完了画面を確実にスクロールさせるためである。
 */
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

    // 前提 1: チャットスロットは描画されていない（＝直前の兄弟が数えられない配置）。
    const slot = await page.evaluate(() => {
      const el = document.querySelector('.kiosk-chat-slot');
      if (!el) return { present: false, display: 'absent' };
      return { present: true, display: window.getComputedStyle(el).display };
    });
    expect(
      slot.display,
      'この画面ではチャットスロットが数えられない（absent か display:none）',
    ).not.toBe('flex');

    // 前提 2: 実際に覆っている。
    const m = await measureOcclusion(page);
    expect(m, 'この画面にも逃げ道バーは在る').not.toBeNull();
    expect(m!.hiddenUnderBar.length, 'バーの下に内容が潜っている').toBeGreaterThan(0);

    await expect(page.getByTestId(MORE)).toBeVisible();
  });
});
