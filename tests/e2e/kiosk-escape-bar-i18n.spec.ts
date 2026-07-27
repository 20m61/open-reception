import { test, expect, type Page } from './kiosk-fixtures';

/**
 * 常設の逃げ道バーの i18n スモーク (issue #327 follow-up)。
 *
 * 逃げ道バーは待機以外の**全画面に常設**される唯一の後退導線 (#325)。ここが日本語固定だと、
 * English を選んだ来訪者が受付中ずっと日本語のボタンを見続けることになる。#327 の受入条件
 * 「English/한국어/中文 で待機→受付→退館の全導線に未翻訳文言が出ない」は、待機サイネージと
 * 退館チェックアウトについては検証されていたが、**受付進行中の常設バーは検証されていなかった**。
 *
 * サイネージ/チェックアウトの `?locale=` と違い、`/kiosk` の言語は待機画面の言語切替
 * （`LanguageSwitcher`）で選ぶ。切替のセレクタは `kiosk-checkout-i18n.spec.ts` と同じく
 * 母国語ラベル（意図的に非翻訳）で引く＝ラベル文言や実装属性に依存しない。
 */

/** ひらがな・カタカナ・CJK 統合漢字・ハングルの検出（英語ロケールでの露出チェック用）。 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿가-힣]/;

/** 待機画面から担当者選択（逃げ道バーが back/reset の 2 つとも出る状態）まで進める。 */
async function advanceToTargetSelection(page: Page) {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
}

test('既定 (ja) の逃げ道バーは日本語で表示される（回帰の固定）', async ({ page }) => {
  await page.goto('/kiosk');
  await advanceToTargetSelection(page);

  await expect(page.getByTestId('escape-back')).toHaveText('戻る');
  await expect(page.getByTestId('escape-reset')).toHaveText('最初に戻る');
});

test('English を選ぶと逃げ道バーが英語になり、日本語が露出しない', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await advanceToTargetSelection(page);

  await expect(page.getByTestId('escape-back')).toHaveText('Back');
  await expect(page.getByTestId('escape-reset')).toHaveText('Start over');

  const bar = page.getByTestId('kiosk-escape-bar');
  // 読み上げ言語が本文と食い違わないよう nav に lang を付けている（子ボタンへ継承される）。
  await expect(bar).toHaveAttribute('lang', 'en');
  // 読み上げ用の nav ラベルも訳す（見えないが読み上げられる文言も導線の一部）。
  // ボタンを列挙しない文言にしてある（出るボタンは状態で変わるため）。
  await expect(bar).toHaveAttribute('aria-label', 'Reception controls');

  const barText = await bar.innerText();
  expect(CJK_PATTERN.test(barText), `未翻訳の CJK が残っている: ${barText}`).toBe(false);
});

test('English のまま Start over を押しても操作が壊れず、待機画面は既定言語へ戻る', async ({
  page,
}) => {
  await page.goto('/kiosk');
  await page.getByRole('button', { name: 'English' }).click();
  await advanceToTargetSelection(page);

  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  // idle へ戻ったら表示言語は既定へ戻る＝選んだ言語を次の来訪者へ持ち越さない (#103)。
  // 逃げ道の i18n 化でこの後始末が壊れていないことを固定する。
  await expect(page.getByTestId('start-reception')).toContainText('担当者を呼ぶ');
});
