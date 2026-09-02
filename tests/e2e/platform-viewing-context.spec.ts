import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * platform ヘッダの「表示中テナント」(issue #423)。
 *
 * ヘッダは Cookie の選択（sticky）を出す一方、`/platform/tenants/[tenantId]` の本文は URL の
 * テナントを出していた。両者は独立に解決されるので、**テナント詳細を開いているのにヘッダが
 * 「全テナント横断」や別テナントを示す**状態が起き得た（#423 AC「主要画面で現在の tenant が
 * 常に確認できる」に反する）。
 *
 * 判定は `resolveContextScope`（優先順位の契約）→ `resolveViewingContext`（表示名の解決）で、
 * どちらも unit 済み。**ここはヘッダが実際にそれを描いているかの消費者**（登録簿だけあって
 * ズレていれば無意味、という #497 と同じ関心）。
 */

/**
 * platform エリアは developer ロール専用。password セッションが developer になるのは
 * `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` の**プロセス env** 指定時だけ
 * （`src/lib/auth/actor.ts` の `buildActorFromPasswordSession` / `buildActorConfig`）なので、
 * この spec は **専用の Next プロセスへ向けた `platform-developer` project からのみ**走る
 * （`playwright.config.ts`）。既定 project からは testIgnore で外してある。
 *
 * したがって**到達できないのは設定の破損**であり、skip ではなく失敗させる。第 85 wave までは
 * skip にしていたが、それは developer セッションを張る手段が無かった間の措置。
 *
 * 直った既存の穴: 「platform 主要画面」のスクショは撮るだけで検証しなかったため、同じ理由で
 * **ずっと admin を撮っていた**（スクショは撮れるので誰も気づかない）。
 * → `capture-screens-platform.spec.ts` へ分離し、この project で撮る。
 */
test.describe('platform: いま見ているテナントがヘッダに出る (#423)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/platform/tenants');
    await expect(
      page.getByTestId('platform-tenant-switcher'),
      'platform へ到達できていない（developer セッションが張れていない）',
    ).toBeVisible();
  });

  test('一覧ではテナントを名指ししないので「表示中」は出ない', async ({ page }) => {
    await page.goto('/platform/tenants');
    await expect(page.getByTestId('platform-tenant-switcher')).toBeVisible();
    await expect(page.getByTestId('platform-viewing-tenant')).toHaveCount(0);
  });

  test('テナント詳細を開くとヘッダに「表示中: <テナント名>」が出る', async ({ page }) => {
    await page.goto('/platform/tenants');
    // id をハードコードせず一覧の最初の詳細リンクから入る（seed に依存しない）。
    const detail = page.locator('a[href^="/platform/tenants/"]').first();
    await expect(detail).toBeVisible();
    const name = (await detail.textContent())?.trim() ?? '';
    await detail.click();

    const viewing = page.getByTestId('platform-viewing-tenant');
    await expect(viewing).toBeVisible();
    // 一覧のリンク文言がテナント名そのものでない実装もあり得るので、非空であることと
    // ヘッダ・本文が同じ画面を指していることを確認する（名前一致は下の切替テストで固定）。
    expect((await viewing.innerText()).trim().length).toBeGreaterThan(0);
    if (name !== '') expect(await viewing.innerText()).toContain(name);
  });

  test('選択中(sticky)と別のテナントを開くと「選択中と別」を併記する', async ({ page }) => {
    await page.goto('/platform/tenants');
    const options = page.getByTestId('platform-tenant-switcher').locator('option');
    // 「全テナント横断」+ 実テナントが 2 件以上ないとこのケースは作れない。
    const count = await options.count();
    test.skip(count < 3, '実テナントが 2 件未満のため sticky と別テナントを作れない');

    // 1 件目を sticky に選ぶ（切替はサーバ API 経由でフルリロードされる）。
    const firstId = await options.nth(1).getAttribute('value');
    const secondId = await options.nth(2).getAttribute('value');
    await page.getByTestId('platform-tenant-switcher').selectOption(firstId ?? '');
    await expect(page.getByTestId('platform-tenant-switcher')).toHaveValue(firstId ?? '');

    // 2 件目の詳細を開く → sticky は 1 件目のまま、表示中は 2 件目。
    await page.goto(`/platform/tenants/${secondId}`);
    await expect(page.getByTestId('platform-viewing-differs')).toBeVisible();
    // **sticky は書き換わらない**（#423 AC「画面移動で対象が暗黙に別テナントへ切り替わらない」）。
    await expect(page.getByTestId('platform-tenant-switcher')).toHaveValue(firstId ?? '');
  });

  test('権威に無い id を URL に打っても「表示中」は出ない', async ({ page }) => {
    // URL は誰でも打てる（#419「クライアントが送る識別子は権威にしない」）。
    await page.goto('/platform/tenants/not-a-real-tenant');
    await expect(page.getByTestId('platform-viewing-tenant')).toHaveCount(0);
  });
});
