import { test, expect } from './kiosk-fixtures';

/**
 * 常設の逃げ道バーの i18n スモーク (issue #327 follow-up)。
 *
 * 逃げ道バーは待機以外の**全画面に常設**される唯一の後退導線 (#325)。ここが日本語固定だと、
 * English を選んだ来訪者が受付中ずっと日本語のボタンを見続けることになる。#327 の受入条件
 * 「English/한국어/中文 で待機→受付→退館の全導線に未翻訳文言が出ない」は、待機サイネージと
 * 退館チェックアウトについては検証されていたが、**受付進行中の常設バーは検証されていなかった**。
 *
 * サイネージ/チェックアウトの `?locale=` と違い、`/kiosk` の言語は待機画面の言語切替
 * （`LanguageSwitcher`）で選ぶ。切替後に受付を進め、バーの文言と読み上げラベルを検証する。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

/** 待機画面で English を選び、担当者選択（逃げ道バーが出る状態）まで進める。 */
async function advanceToTargetSelection(page: import('@playwright/test').Page, lang: string) {
  await page.goto('/kiosk');
  await page.getByRole('group', { name: /Language|言語/ }).locator(`button[lang="${lang}"]`).click();
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
}

test('既定 (ja) の逃げ道バーは日本語で表示される（回帰の固定）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('escape-back')).toHaveText('戻る');
  await expect(page.getByTestId('escape-reset')).toHaveText('最初に戻る');
});

test('English を選ぶと逃げ道バーが英語になり、日本語が露出しない', async ({ page }) => {
  await advanceToTargetSelection(page, 'en');

  await expect(page.getByTestId('escape-back')).toHaveText('Back');
  await expect(page.getByTestId('escape-reset')).toHaveText('Start over');

  const bar = page.getByTestId('kiosk-escape-bar');
  await expect(bar).toHaveAttribute('lang', 'en');
  // 読み上げ用の nav ラベルも訳される（見えないが読み上げられる文言も導線の一部）。
  await expect(bar).toHaveAttribute('aria-label', 'Reception controls (back, start over)');

  const barText = await bar.innerText();
  expect(CJK_PATTERN.test(barText), `未翻訳の CJK が残っている: ${barText}`).toBe(false);
});

test('English のまま「Start over」で待機画面へ戻れる（訳しても操作が壊れない）', async ({
  page,
}) => {
  await advanceToTargetSelection(page, 'en');

  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
});
