import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 待機画面の見出しと「見やすさ設定」ボタンの**幾何的な**衝突を固定する (issue #617)。
 *
 * `.a11y-menu__button` は `position: fixed` で右上に固定される。iPad 横置きでは
 * `.kiosk-idle__head` が右カラム上段（= まさにボタンの真下）に来るため、見出しの末尾が
 * ボタンの下へ潜り込む。実デプロイのキャプチャで初めて分かった欠陥で、**axe は検出しない**
 * （要素は存在し、コントラストも取れている）。
 *
 * ## 判定を「テキストの行矩形」で行う理由
 *
 * 要素の bounding box ではなく `Range#getClientRects()` の行矩形で見る。見出しは
 * shrink-to-fit なので box と描画テキストがずれる（英語は 2 行に折れて box だけがカラム全幅に
 * なる）。読めるかどうかを決めるのは**行矩形**であって box ではない。
 *
 * ## フォント読込を待つ必要がある
 *
 * 日本語は境界ぎりぎり（実測 49.6px の食い込み）で、フォント差替え前後で重なりの有無が
 * 変わる。`document.fonts.ready` を待たずに測ると偶然 green になる回がある
 * （実際に同一条件で overlap=0 と 1983 の両方を観測した）。**過渡状態を 1 点で判定しない。**
 *
 * ## 副作用も同じテストで固定する
 *
 * 見出しを横に狭める回避策は、`.kiosk-idle__head` に入れると言語ボタン 4 つを折り返させ、
 * 見出しに入れると英語が 3 行に折れる。回避策が別の欠陥を生んでいないことを併せて押さえる。
 */

// iPad (gen 7) 横置き相当。resolveKioskLayout が `ipad-landscape` を返す幅・比率。
test.use({ viewport: { width: 1080, height: 810 }, hasTouch: true });

/** 言語切替の母国語ラベル（意図的に非翻訳）。既定 ja を含め全 4 言語を回す。 */
const LOCALES = [
  { label: '日本語', tag: 'ja', maxTitleLines: 1 },
  { label: 'English', tag: 'en', maxTitleLines: 2 },
  { label: '한국어', tag: 'ko', maxTitleLines: 1 },
  { label: '中文', tag: 'zh', maxTitleLines: 1 },
] as const;

/** 待機画面を開き、フォント確定後に指定言語へ切り替え、来訪者が最初に見る位置へ戻す。 */
async function openIdleIn(page: Page, label: string): Promise<void> {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: label, exact: true }).click();
  // .kiosk-idle__head は kiosk-rise で translateY する。途中の座標で測ると偽陰性になる。
  await page.waitForTimeout(700);
  // 待機画面は縦にはみ出しており、言語ボタンのフォーカス送りでページがスクロールする。
  // その状態で測ると見出しが画面外（実測 y=-169）へ抜けて**重なりが消えたように見える**。
  // ボタンは position:fixed なので、判定は来訪者が最初に見る scrollTop=0 で行う。
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
}

/** 見出しの各行と「見やすさ設定」ボタンの重なり面積(px^2)と、行数を測る。 */
async function measureTitleClearance(page: Page): Promise<{ overlap: number; lines: number }> {
  await expect(page.locator('.kiosk-idle__head .screen__title')).toBeVisible();
  await expect(page.locator('.a11y-menu__button')).toBeVisible();
  return page.evaluate(() => {
    const title = document.querySelector('.kiosk-idle__head .screen__title');
    const button = document.querySelector('.a11y-menu__button');
    if (title === null || button === null) {
      throw new Error('idle title or a11y button is missing');
    }
    const b = button.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(title);
    const lineRects = [...range.getClientRects()];
    const area = (r: DOMRect) => {
      const w = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const h = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      return w > 0 && h > 0 ? w * h : 0;
    };
    return {
      overlap: Math.round(lineRects.reduce((sum, r) => sum + area(r), 0)),
      lines: lineRects.length,
    };
  });
}

for (const { label, tag, maxTitleLines } of LOCALES) {
  test(`待機見出しが「見やすさ設定」ボタンと重ならない (${tag})`, async ({ page }) => {
    await openIdleIn(page, label);

    const { overlap, lines } = await measureTitleClearance(page);

    expect(overlap, `見出しがボタンの下に潜り込んでいる (${tag}) overlap=${overlap}px^2`).toBe(0);
    // 横方向に逃がす修正は見出しを余計に折り返す。行数を上限で押さえて回避策の後退を検出する。
    expect(lines, `見出しの折り返しが増えている (${tag}) lines=${lines}`).toBeLessThanOrEqual(
      maxTitleLines,
    );
  });

  test(`言語ボタン 4 つが 1 行に収まる (${tag})`, async ({ page }) => {
    await openIdleIn(page, label);

    const buttons = page.getByTestId('kiosk-language-switcher').getByRole('button');
    await expect(buttons).toHaveCount(LOCALES.length);

    const tops: number[] = [];
    for (let i = 0; i < LOCALES.length; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      tops.push(Math.round((box as { y: number }).y));
    }
    // 折り返すと 2 行目の y が変わる。全ボタンが同じ行なら上端は一致する。
    expect(new Set(tops).size, `言語ボタンが折り返している: tops=${tops.join(',')}`).toBe(1);
  });
}
