import { test, expect, type Page, revealStaff } from './kiosk-fixtures';
import AxeBuilder from '@axe-core/playwright';

/**
 * 来訪者が選べるアクセシビリティ支援モードの E2E (issue #321)。
 *
 * AC:
 *   1. 全 kiosk 画面でモード切替が 1〜2 タップで到達できる（常設アクセシビリティボタン）。
 *   2. 各モードで受付フローが完走できる。
 *   3. axe critical/serious 0 を全モードで維持。
 *   4. 終端/無操作リセット後に既定表示へ自動復帰（次の来訪者へ持ち越さない）。
 *
 * テナント有効/無効の切り替え検証（グローバル設定を書き換える）は
 * kiosk-a11y-tenant-toggle.spec.ts へ分離する（他 kiosk テストと並行実行させない, playwright.config.ts）。
 */

/** critical/serious のみを対象にする（AC3。moderate/minor は段階的改善対象として既存方針を踏襲）。 */
async function criticalOrSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

const screen = () => `main.screen`;

/** 目的選択 → 担当者（staff-sato=connected で決定的）→ 情報入力 → 確認画面まで進める。 */
async function advanceToConfirm(page: Page) {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
}

/** 確認 → 呼び出し → 接続まで進める（受付フロー完走の確認, AC2）。 */
async function completeToConnected(page: Page) {
  await advanceToConfirm(page);
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible({ timeout: 20_000 });
}

test.describe('常設アクセシビリティ支援モードボタン (AC1)', () => {
  test('待機画面からワンタップでパネルを開ける', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible();
    const button = page.getByTestId('a11y-menu-button');
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId('a11y-menu-panel')).toBeVisible();
  });

  test('4 つのモードが 2 タップ以内で選べる（開く→選ぶ）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await expect(page.getByTestId('a11y-font-scale-1.3')).toBeVisible();
    await expect(page.getByTestId('a11y-contrast-toggle')).toBeVisible();
    await expect(page.getByTestId('a11y-lowreach-toggle')).toBeVisible();
    await expect(page.getByTestId('a11y-simple-japanese-toggle')).toBeVisible();
  });

  test('受付フロー中（確認画面）でも同じ場所から到達できる', async ({ page }) => {
    await page.goto('/kiosk');
    await advanceToConfirm(page);
    await expect(page.getByTestId('a11y-menu-button')).toBeVisible();
    await page.getByTestId('a11y-menu-button').click();
    await expect(page.getByTestId('a11y-menu-panel')).toBeVisible();
  });

  test('閉じるボタンでパネルを閉じられる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await expect(page.getByTestId('a11y-menu-panel')).toBeVisible();
    await page.getByTestId('a11y-menu-close').click();
    await expect(page.getByTestId('a11y-menu-panel')).toBeHidden();
  });
});

test.describe('大きな文字 (AC2/AC3)', () => {
  test('選択すると data-a11y-font-scale が反映され、受付フローを完走できる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-font-scale-1.6').click();
    await expect(page.getByTestId('a11y-font-scale-1.6')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(screen())).toHaveAttribute('data-a11y-font-scale', '1.6');
    await page.getByTestId('a11y-menu-close').click();
    await completeToConnected(page);
  });

  /**
   * 🔴 **属性ではなく計算値で縛る** (#869)。
   *
   * 上の「data-a11y-font-scale が反映され」は属性の付与しか見ておらず、**寸法が 1 ピクセルも
   * 動いていない状態で 1 年近く緑だった**。原因は 2 段あった:
   *
   * 1. `:root` の `--font-body` 等は宣言時点で `calc(1.25rem * 1)` へ置換済みで、子孫で
   *    `--a11y-font-scale` を上書きしても再計算されない
   * 2. それを直しても、`.screen__title` の `clamp(1.9rem, 4.6vw, var(--font-xl))` は
   *    トークンを**上限にしか使っていない**ため、`4.6vw` が勝つ幅では倍率が届かない
   *
   * (1) は `tests/config/css-custom-property-definitions.test.ts` が静的に縛るが、**(2) は
   * 静的検査では見えない** —— どの項が勝つかは viewport 次第だからである。ここで実測する。
   *
   * 代表として見出し・本文・主 CTA の 3 種を採る（それぞれ clamp あり / clamp あり /
   * トークン直参照で、拡大の経路が違う）。
   */
  test('1.6× で画面上の文字の計算値が実際に拡大する', async ({ page }) => {
    /*
     * 「この画面に在る要素**すべて**が拡大する」という不変条件で見る。
     * 特定のセレクタを名指しすると画面ごとの構成差で落ちる（実際、待機画面には
     * `.screen__title` が無い —— `screenTitleFor('idle')` が null を返すため）。
     */
    const CANDIDATES = ['.screen__title', '.screen__lead', '.btn', '.card--cta'] as const;

    const sizes = async () =>
      page.evaluate((sels) => {
        const out: Record<string, number> = {};
        for (const sel of sels) {
          const el = document.querySelector(`main.screen ${sel}`);
          if (el) out[sel] = parseFloat(getComputedStyle(el).fontSize);
        }
        return out;
      }, CANDIDATES as unknown as string[]);

    await page.goto('/kiosk');
    await expect(page.getByTestId('start-reception')).toBeVisible();
    const before = await sizes();

    /*
     * 下界を併せて縛る (#869)。測れた要素が 0〜1 個だと「全部拡大した」は空虚に満たせる。
     * 待機画面には少なくともリード文と入口カードがある。
     */
    expect(
      Object.keys(before).length,
      `拡大を観測できる要素が足りない（測れたのは ${JSON.stringify(before)}）`,
    ).toBeGreaterThanOrEqual(2);
    for (const [sel, value] of Object.entries(before)) {
      expect(value, `${sel} の 1× サイズ`).toBeGreaterThan(0);
    }

    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-font-scale-1.6').click();
    await page.getByTestId('a11y-menu-close').click();
    await expect(page.locator(screen())).toHaveAttribute('data-a11y-font-scale', '1.6');

    const after = await sizes();
    expect(Object.keys(after).sort(), '1.6× で要素の構成が変わってはいけない').toEqual(
      Object.keys(before).sort(),
    );
    for (const [sel, value] of Object.entries(before)) {
      expect(
        after[sel],
        `${sel}: 1.6× を選んでも計算値が ${value}px から動いていない（#869 の再発）`,
      ).toBeGreaterThan(value);
    }
  });

  test('axe: critical/serious 違反がない（待機画面・確認画面）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-font-scale-1.6').click();
    await page.getByTestId('a11y-menu-close').click();
    expect(await criticalOrSeriousViolations(page)).toEqual([]);

    await advanceToConfirm(page);
    expect(await criticalOrSeriousViolations(page)).toEqual([]);
  });
});

test.describe('ハイコントラスト (AC2/AC3)', () => {
  test('選択すると data-a11y-contrast が反映され、受付フローを完走できる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-contrast-toggle').click();
    await expect(page.getByTestId('a11y-contrast-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(screen())).toHaveAttribute('data-a11y-contrast', 'high');
    await page.getByTestId('a11y-menu-close').click();
    await completeToConnected(page);
  });

  test('axe: critical/serious 違反がない（待機画面・確認画面）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-contrast-toggle').click();
    await page.getByTestId('a11y-menu-close').click();
    expect(await criticalOrSeriousViolations(page)).toEqual([]);

    await advanceToConfirm(page);
    expect(await criticalOrSeriousViolations(page)).toEqual([]);
  });
});

test.describe('低位置レイアウト (AC2/AC3)', () => {
  test('選択すると data-a11y-reach が反映され、受付フローを完走できる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-lowreach-toggle').click();
    await expect(page.getByTestId('a11y-lowreach-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(screen())).toHaveAttribute('data-a11y-reach', 'low');
    await page.getByTestId('a11y-menu-close').click();
    await completeToConnected(page);
  });

  test('axe: critical/serious 違反がない（待機画面・確認画面）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-lowreach-toggle').click();
    await page.getByTestId('a11y-menu-close').click();
    expect(await criticalOrSeriousViolations(page)).toEqual([]);

    await advanceToConfirm(page);
    expect(await criticalOrSeriousViolations(page)).toEqual([]);
  });
});

test.describe('やさしい日本語 (AC2/AC3)', () => {
  test('選択すると主要フロー画面の文言が平易な表現になり、受付フローを完走できる', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-simple-japanese-toggle').click();
    await expect(page.getByTestId('a11y-simple-japanese-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('a11y-menu-close').click();

    // welcome 画面のリードが ja-simple の平易な文言に切り替わる（既定の guidanceIdle 管理文言とは別物）。
    await expect(page.getByTestId('idle-guidance')).toHaveText('ようこそ。画面に さわるだけで うけつけできます');
    await expect(page.getByTestId('idle-guidance')).toHaveAttribute('lang', 'ja');

    await completeToConnected(page);
  });

  test('axe: critical/serious 違反がない（待機画面・確認画面）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-simple-japanese-toggle').click();
    await page.getByTestId('a11y-menu-close').click();
    expect(await criticalOrSeriousViolations(page)).toEqual([]);

    await advanceToConfirm(page);
    expect(await criticalOrSeriousViolations(page)).toEqual([]);
  });
});

test.describe('既定表示への自動復帰 (AC4)', () => {
  test('受付完了→自動復帰後、全モードが既定へ戻る（次の来訪者へ持ち越さない）', async ({ page }) => {
    await page.goto('/kiosk');
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-font-scale-1.6').click();
    await page.getByTestId('a11y-contrast-toggle').click();
    await page.getByTestId('a11y-lowreach-toggle').click();
    await page.getByTestId('a11y-simple-japanese-toggle').click();
    await page.getByTestId('a11y-menu-close').click();

    await completeToConnected(page);
    await page.getByTestId('complete').click();
    await expect(page.getByTestId('completed')).toBeVisible();

    // 既存の自動復帰（AUTO_RESET_MS=6000）で待機画面へ戻る。
    await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator(screen())).toHaveAttribute('data-a11y-font-scale', '1');
    await expect(page.locator(screen())).not.toHaveAttribute('data-a11y-contrast', 'high');
    await expect(page.locator(screen())).not.toHaveAttribute('data-a11y-reach', 'low');

    await page.getByTestId('a11y-menu-button').click();
    await expect(page.getByTestId('a11y-font-scale-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('a11y-contrast-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('a11y-lowreach-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('a11y-simple-japanese-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('無操作リセット後もモードが既定へ戻る', async ({ page }) => {
    await page.goto('/kiosk?inactivityMs=1500');
    await page.getByTestId('start-reception').click();
    await page.getByTestId('a11y-menu-button').click();
    await page.getByTestId('a11y-contrast-toggle').click();
    await page.getByTestId('a11y-menu-close').click();
    await expect(page.locator(screen())).toHaveAttribute('data-a11y-contrast', 'high');

    // 無操作のまま待機画面へ自動的に戻る（#125 の既存機構。ここへ新規フックした #321 の
    // リセットも一緒に効くことを確認する）。
    await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(screen())).not.toHaveAttribute('data-a11y-contrast', 'high');
  });
});
