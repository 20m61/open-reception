// **kiosk-fixtures からは import しない**（admin 系の既存 spec と同じ理由）。
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 保存済みの重複した例外日を、読み込んだ時点で運用者へ知らせる (#799)。
 *
 * 🔴 検証（`validatePolicyInput`）は**新規保存を止めるだけ**で、既に入っている重複は残る。
 * 読み側は先勝ちなので、臨時営業日に受付が開かない状態が続く。保存を押すまで気づけないと、
 * そのときには当該の日は過ぎている。
 *
 * この状態は**もう API 経由では作れない**（検証が弾く）ので、GET 応答を差し替えて配線を見る。
 * 判定そのものは unit（`duplicateExceptionDates`）で縛ってあり、ここで見るのは
 * 「読み込み時に呼ばれて画面に出るか」——配線は E2E でしか守れない。
 */
test('保存済みの重複した例外日を、読み込んだ時点で警告する', async ({ page }) => {
  await loginAsAdmin(page);

  await page.route(/\/api\/admin\/operating-policy\?/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        policy: {
          tenantId: 'internal',
          siteId: 'branch-site',
          timezone: 'Asia/Tokyo',
          weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
          fixedHolidays: [],
          exceptionDates: [
            { date: '2026-09-01', closed: true },
            { date: '2026-09-01', closed: false, ranges: [{ start: '10:00', end: '12:00' }] },
          ],
          version: 3,
          updatedAt: '2026-08-01T00:00:00.000Z',
          updatedBy: 'someone@example.com',
        },
      }),
    });
  });

  await page.goto('/admin/operating-hours?siteId=branch-site');

  const warning = page.getByTestId('operating-hours-duplicate-exceptions');
  await expect(warning).toBeVisible();
  // どの日か・なぜ効かないか・どう直すかが揃っていること（「1 件だけ」で終わると行を消される）。
  await expect(warning).toContainText('2026-09-01');
  await expect(warning).toContainText('最初の 1 件だけが有効');
  await expect(warning).toContainText('カンマで区切');
});

test('重複が無ければ警告を出さない', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/operating-hours?siteId=branch-site');
  await expect(page.getByTestId('operating-hours-save')).toBeEnabled();
  await expect(page.getByTestId('operating-hours-duplicate-exceptions')).toHaveCount(0);
});
