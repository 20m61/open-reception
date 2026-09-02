import { test, expect } from '@playwright/test';
import { establishKioskSession } from './helpers';
import { PERSISTENT_ELEMENTS } from '../../src/components/kiosk/persistent-regions';
import { isPersistentVisible, PERSISTENT_REGIONS } from '../../src/domain/reception/ui-contract';

/**
 * 常設要素の領域帰属を実 DOM と突き合わせる (#422 inc5-c 増分 2)。
 *
 * 登録簿（`persistent-regions.ts`）は `data-persistent-region` 属性の唯一の供給元。
 * **登録簿だけあっても、実際に描かれる要素とズレていれば意味がない**（このセッションが
 * 繰り返し潰してきた「消費者ゼロの契約は腐る」と同じ形）。ここで実ページと突き合わせる。
 *
 * 常設要素は受付のどの局面でも視界に居座るので、増えるほど来訪者の注意が分散する。
 * 3 領域（案内・回答対象・ヘルプ）に属せないものは常設すべきではない、という判断の足場。
 */

/**
 * 待機画面に出るヘルプ要素。
 * 逃げ道バーは含まない（idle は戻る先が無いので契約が出さない・#325）。
 * 言語切替と退館リンクは待機画面にだけ常設する。
 */
const HELP_ON_IDLE = ['a11y-menu-button', 'kiosk-language-switcher', 'kiosk-checkout-link'] as const;

test.describe('常設要素の 3 領域 (#422 inc5-c)', () => {
  test('待機画面の常設要素はすべて登録済みの領域を持つ', async ({ page }) => {
    await establishKioskSession(page);
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();

    const rendered = await page.locator('[data-persistent-region]').evaluateAll((nodes) =>
      nodes.map((n) => ({
        testId: n.getAttribute('data-testid') ?? '',
        region: n.getAttribute('data-persistent-region') ?? '',
      })),
    );

    // 1 つも見つからないなら配線が外れている（空配列で緑にしない）。
    expect(rendered.length).toBeGreaterThan(0);

    for (const element of rendered) {
      // 領域は 3 語彙のいずれか。
      expect(PERSISTENT_REGIONS, element.testId).toContain(element.region);
      // 属性は登録簿からしか供給されないので、登録簿の値と一致する。
      const registered = PERSISTENT_ELEMENTS.find((e) => e.testId === element.testId);
      expect(registered, `未登録の常設要素が描かれている: ${element.testId}`).toBeTruthy();
      expect(element.region, element.testId).toBe(registered?.region);
    }
  });

  test('待機画面で出るべきヘルプ要素が実際に出ている', async ({ page }) => {
    await establishKioskSession(page);
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();

    for (const testId of HELP_ON_IDLE) {
      await expect(page.getByTestId(testId), testId).toHaveAttribute(
        'data-persistent-region',
        'help',
      );
    }
  });

  test('受付が進むと逃げ道バーがヘルプ領域として現れる', async ({ page }) => {
    await establishKioskSession(page);
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();

    await expect(page.getByTestId('kiosk-escape-bar')).toHaveAttribute(
      'data-persistent-region',
      'help',
    );
  });
});

/**
 * 契約が「出す/出さない」と言っている常設要素が、実ページでもそのとおりか (#500)。
 *
 * **契約に消費者を置くのが目的。** 判断だけ契約へ寄せても、画面が別の条件で描いていれば
 * 意味がない（#489 で契約を直したのに `ResultView` が自前判断を続けていたのと同じ形）。
 */
test.describe('常設要素の表示可否が契約と一致する (#500)', () => {
  test('待機画面: 契約の主張どおりに出る／出ない', async ({ page }) => {
    await establishKioskSession(page);
    await page.goto('/kiosk');
    await expect(page.getByTestId('kiosk-idle')).toBeVisible();

    for (const element of PERSISTENT_ELEMENTS) {
      if (element.key === undefined) continue;
      const expected = isPersistentVisible(element.key, 'idle');
      const count = await page.getByTestId(element.testId).count();
      expect(count > 0, `${element.testId} (契約: ${expected ? '出す' : '出さない'})`).toBe(expected);
    }
  });

  test('用件選択画面: 待機だけの要素が消え、進行中の要素が現れる', async ({ page }) => {
    await establishKioskSession(page);
    await page.goto('/kiosk');
    await page.getByTestId('start-reception').click();
    await expect(page.getByTestId('purpose-meeting')).toBeVisible();

    for (const element of PERSISTENT_ELEMENTS) {
      if (element.key === undefined) continue;
      const expected = isPersistentVisible(element.key, 'selectingPurpose');
      const count = await page.getByTestId(element.testId).count();
      expect(count > 0, `${element.testId} (契約: ${expected ? '出す' : '出さない'})`).toBe(expected);
    }
  });
});
