import { test, expect, type Page } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * **書き込みが失敗したことが運用者に見える** (#870 増分 02)。
 *
 * 書き込みが `await fetch(...)` の戻りを見ずに `await load()` していたため、403 / 409 / 5xx でも
 * 一覧を取り直すだけで行が静かに元へ戻っていた。運用者には**「何も起きなかった」のか
 * 「失敗した」のかが区別できない** —— viewer ロールが担当者を無効化したつもりで
 * 無効化できていない、が黙って起こる。
 *
 * ## なぜ e2e が要るか
 *
 * 構造テスト（`tests/config/admin-write-failure.test.ts`）が言えるのは「戻りを束縛している」
 * までで、**束縛したうえで無視している**実装は通ってしまう。実際に失敗を注入して、
 * 画面に出るところまで見る。
 *
 * 500 と接続断の 2 通りを見るのは読み取り側（`admin-read-failure.spec.ts`）と同じ理由で、
 * 握り潰しの経路が別だから（`res.ok === false` と `fetch` 自身の throw）。
 *
 * **この spec は書き込みを注入で全部落とすので、共有 seed を変更しない。** ルートは
 * この page context にしか効かないため、並行実行しているほかの spec にも影響しない。
 */
async function failWrites(page: Page, pattern: string, mode: '500' | 'abort'): Promise<void> {
  await page.route(pattern, (route) => {
    // 読み取り（GET）は通す。書き込みだけ落とすことで「読めているのに書けない」を作る。
    if (route.request().method() === 'GET') return route.continue();
    return mode === '500'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
      : route.abort('failed');
  });
}

const SCREENS = [
  {
    name: '拠点',
    path: '/admin/sites',
    api: '**/api/admin/sites**',
    input: 'site-name-input',
    submit: 'site-add',
    errorTestId: 'site-save-error',
  },
  {
    name: '部署',
    path: '/admin/departments',
    api: '**/api/admin/departments**',
    input: 'dept-name-input',
    submit: 'dept-add',
    errorTestId: 'dept-save-error',
  },
  {
    name: '受付端末（旧）',
    path: '/admin/kiosks',
    api: '**/api/admin/kiosks**',
    input: 'kiosk-name-input',
    submit: 'kiosk-add',
    errorTestId: 'kiosk-save-error',
  },
] as const;

test.describe('管理: 書き込み失敗が運用者に見える (#870 増分 02)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const screen of SCREENS) {
    test(`${screen.name}: 500 のとき失敗が表示される（黙って元に戻らない）`, async ({ page }) => {
      await page.goto(screen.path);
      await failWrites(page, screen.api, '500');

      await page.getByTestId(screen.input).fill('失敗注入テスト');
      await page.getByTestId(screen.submit).click();

      // **これが本題。** 以前はここで何も出ず、入力欄が空になって一覧が元のまま返るだけだった。
      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();
      // 失敗は assertive で読み上げる（見ていない運用者にも届く）。
      await expect(page.getByTestId(screen.errorTestId)).toHaveAttribute('role', 'alert');
    });

    test(`${screen.name}: 接続断でも失敗が表示される`, async ({ page }) => {
      // `fetch` 自身が throw する経路。`catch` を書き忘れるとここだけ黙る。
      await page.goto(screen.path);
      await failWrites(page, screen.api, 'abort');

      await page.getByTestId(screen.input).fill('接続断テスト');
      await page.getByTestId(screen.submit).click();

      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();
    });

    test(`${screen.name}: 失敗しても入力が消えない（やり直せる）`, async ({ page }) => {
      // **下界。** 「失敗を出す」だけの実装でも上の 2 本は通る。入力を捨ててしまうと
      // 運用者は打ち直しになるので、失敗時は入力を残すところまで縛る。
      await page.goto(screen.path);
      await failWrites(page, screen.api, '500');

      await page.getByTestId(screen.input).fill('打ち直したくない値');
      await page.getByTestId(screen.submit).click();
      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();

      await expect(page.getByTestId(screen.input)).toHaveValue('打ち直したくない値');
    });
  }

  /**
   * 設定保存（PUT）の画面 (#973 増分 02)。
   *
   * ## なぜ別の配列なのか
   *
   * 上の `SCREENS` は「値を入れて追加する」形（`input` → `submit`）だが、設定画面は
   * **既に載っている値を保存し直す**だけで入力欄が要らない。同じループに載せると
   * `input` が空の形を作ることになる。
   *
   * ## なぜ e2e が要るか（構造テストの限界）
   *
   * `src/components/admin/ui/save-outcome.test.ts` の配線検査は**綴りの存在検査**なので、
   * 独立レビューの実測で次の変異が全部生存した:
   *
   * - 報告を恒偽の条件で包む
   * - `save` の越境ガードを消す
   * - `if (res.ok)` を反転させ、**失敗したのに「有効にしました」と出す**
   *
   * どれも「押して、通信を落として、画面を見る」でしか落ちない。
   */
  const SAVE_SCREENS = [
    { name: 'AI 案内', path: '/admin/ai-guidance', api: '**/api/admin/ai-guidance**', submit: 'ai-guidance-save', errorTestId: 'ai-guidance-error' },
    { name: 'ブランディング', path: '/admin/branding', api: '**/api/admin/branding**', submit: 'brand-save', errorTestId: 'brand-save-error' },
    { name: '言語設定', path: '/admin/languages', api: '**/api/admin/languages**', submit: 'lang-save', errorTestId: 'lang-error' },
    { name: 'セキュリティ設定', path: '/admin/security', api: '**/api/admin/security**', submit: 'security-save', errorTestId: 'security-error' },
    { name: '音声設定', path: '/admin/voice', api: '**/api/admin/voice**', submit: 'voice-save', errorTestId: 'voice-error' },
    { name: 'サイネージ', path: '/admin/signage', api: '**/api/admin/signage**', submit: 'signage-save', errorTestId: 'signage-save-error' },
    { name: '営業時間', path: '/admin/operating-hours', api: '**/api/admin/operating-policy**', submit: 'operating-hours-save', errorTestId: 'operating-hours-error' },
  ] as const;

  for (const screen of SAVE_SCREENS) {
    test(`${screen.name}: 接続断のとき保存の失敗が表示される (#973)`, async ({ page }) => {
      await page.goto(screen.path);
      // 保存ボタンが出る＝読み取りは済んでいる。ここから書き込みだけ落とす。
      await expect(page.getByTestId(screen.submit)).toBeVisible();
      await failWrites(page, screen.api, 'abort');

      await page.getByTestId(screen.submit).click();

      // **これが本題。** `catch` が無かったときはボタンが戻るだけで何も出なかった。
      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();
      await expect(page.getByTestId(screen.errorTestId)).toHaveAttribute('role', 'alert');
    });

    test(`${screen.name}: 500 のとき保存の失敗が表示される`, async ({ page }) => {
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.submit)).toBeVisible();
      await failWrites(page, screen.api, '500');

      await page.getByTestId(screen.submit).click();

      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();
    });

    test(`${screen.name}: 失敗しても押し直せる（ボタンが固まらない）`, async ({ page }) => {
      // **下界。** 失敗を出すだけの実装でも上の 2 本は通る。`SignageManager` は実際に
      // `finally` が無く、reject すると `busy` が true のまま**押せなくなった**。
      await page.goto(screen.path);
      await expect(page.getByTestId(screen.submit)).toBeVisible();
      await failWrites(page, screen.api, 'abort');

      await page.getByTestId(screen.submit).click();
      await expect(page.getByTestId(screen.errorTestId)).toBeVisible();

      await expect(page.getByTestId(screen.submit)).toBeEnabled();
    });
  }

  /**
   * 緊急停止は**受付を止める操作**なので、成否の取り違えの代償が最も大きい (#973)。
   * `if (res.ok)` を反転させる変異が unit 8114 本を素通りした（独立レビューの実測）。
   */
  test('緊急停止: 失敗したときに「有効にしました」と言わない (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', '500');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    await expect(page.getByTestId('emergency-error')).toBeVisible();
    await expect(page.getByTestId('emergency-error')).toHaveAttribute('role', 'alert');
    // 成功側が出ていないこと（分岐が逆になっていたら、これが落ちる）。
    await expect(page.getByTestId('emergency-saved')).toHaveCount(0);
    // 表示は「通常稼働」のまま（止まっていないのに止まったように見せない）。
    await expect(page.getByTestId('emergency-state')).toContainText('通常稼働');
  });

  test('緊急停止: 接続断でも黙らない (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', 'abort');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    await expect(page.getByTestId('emergency-error')).toBeVisible();
    // 送信中の窓が終わって、押し直せる状態に戻っていること。
    await expect(page.getByTestId('emergency-stop')).toBeEnabled();
  });

  test('部署: 有効/無効の切り替えが失敗したら伝える（行が黙って戻らない）', async ({ page }) => {
    await page.goto('/admin/departments');
    // 行が出てから注入する（読み取りは通すが、念のため描画を待つ）。
    await expect(page.getByTestId('dept-toggle').first()).toBeVisible();
    await failWrites(page, '**/api/admin/departments**', '500');

    await page.getByTestId('dept-toggle').first().click();
    await expect(page.getByTestId('dept-save-error')).toBeVisible();
  });
});
