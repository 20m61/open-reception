import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 待機画面が viewport に収まることを固定する (issue #620)。
 *
 * 受付端末は**スクロールしない前提**の画面である。初見の来訪者は下に何かある事を知らない。
 * ところが実測では、待機画面は全レイアウトで viewport を大きく超えていた
 * （landscape 859px / portrait 1038px / large-display 1049px の超過）。
 * 主要 CTA（`kiosk-quick-actions`）の下端が初期表示の外にあり、押せると気づけない。
 *
 * ## なぜ「見た目」ではなく高さで固定するのか
 *
 * この欠陥は **axe も VRT も検出しなかった**。要素は存在し、コントラストも取れており、
 * VRT の baseline は「はみ出した状態」をそのまま正として焼き付けていたためである
 * （#617 で同種の事故を起こしている）。**性質はスクリーンショットと別にアサーションで書く。**
 *
 * ## 実害は「押せない」だけではない
 *
 * はみ出していると、言語ボタンのフォーカス送りでページがスクロールし、見出しが画面外
 * （実測 y=-169）へ抜ける。#617 のテストはこれを踏んで偽 green になった。
 * よって**来訪者が最初に見る scrollTop=0 の状態**で測る。
 *
 * ## 下限（縮めすぎの検出）
 *
 * 横置きの `.kiosk-idle` は `grid-template-areas: 'avatar head' / 'avatar actions'` で、
 * アバター列は `align-self: start`。グリッド高は `max(アバター, 右カラム)` になるため、
 * 右カラムをアバターより縮めても総高は下がらず**余白が無駄に増えるだけ**。
 * 収まっていることに加えて、CTA が視認できる大きさを保っているかも併せて押さえる。
 */

const LAYOUTS = [
  { name: 'ipad-landscape', width: 1080, height: 810 },
  { name: 'ipad-portrait', width: 810, height: 1080 },
  { name: 'large-display', width: 1920, height: 1080 },
] as const;

/** 言語切替の母国語ラベル（意図的に非翻訳）。文字数が変わると高さも変わるため全 4 言語を回す。 */
const LOCALES = [
  { label: '日本語', tag: 'ja' },
  { label: 'English', tag: 'en' },
  { label: '한국어', tag: 'ko' },
  { label: '中文', tag: 'zh' },
] as const;

/** 待機画面を開き、フォント確定後に指定言語へ切り替え、来訪者が最初に見る位置へ戻す。 */
async function openIdleIn(page: Page, label: string): Promise<void> {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: label, exact: true }).click();
  // kiosk-rise の translateY 中に測ると途中の座標を拾う。
  await page.waitForTimeout(700);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const actions = document.querySelector('[data-testid="kiosk-quick-actions"]');
    return {
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      innerHeight: window.innerHeight,
      actionsBottom: actions === null ? null : Math.round(actions.getBoundingClientRect().bottom),
    };
  });
}

for (const layout of LAYOUTS) {
  for (const { label, tag } of LOCALES) {
    test(`待機画面が viewport に収まる (${layout.name} / ${tag})`, async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await openIdleIn(page, label);

      const { overflow, innerHeight, actionsBottom } = await measure(page);

      expect(
        overflow,
        `待機画面が縦にはみ出している (${layout.name}/${tag}) overflow=${overflow}px`,
      ).toBeLessThanOrEqual(0);

      // はみ出しゼロでも、CTA が折り返しの下に隠れていては意味がない。
      expect(actionsBottom, 'kiosk-quick-actions が見つからない').not.toBeNull();
      expect(
        actionsBottom as number,
        `主要 CTA の下端が初期表示の外にある (${layout.name}/${tag}) bottom=${actionsBottom} > ${innerHeight}`,
      ).toBeLessThanOrEqual(innerHeight);
    });
  }
}
