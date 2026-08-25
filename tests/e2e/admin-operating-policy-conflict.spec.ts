// **kiosk-fixtures からは import しない**（admin 系の既存 spec と同じ理由）。
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 営業時間の同時編集で後勝ち上書きしない (#367)。
 *
 * 🔴 **`default-site` を使わない。** kiosk は `resolveDefaultScope()`（= `default-site`）の
 * 営業時間を読むので、ここで制限的なスケジュールを書くと**受付端末が営業時間外になり、
 * 他の kiosk テストが全滅する**（実際に 136 件落とした）。副作用の閉じた `branch-site`
 * （seed の 2 拠点目・拠点セレクタの検証にしか使われない）で回す。
 *
 * 従来の保存は `get` → `put` の read-modify-write で、2 人の運用者が同じ版を読んで
 * 保存すると**先に保存した側の変更が痕跡なく消えていた**。営業時間は EC2 の起動時間
 * （＝実費）と、営業時間外の発信抑止に直結する。
 *
 * サーバ側の楽観ロックは unit で縛ってある（`src/lib/operating-policy/store.test.ts`）。
 * ここで見るのは**運用者に届くか**——画面が読んだ版を送っていて、409 が「保存していない」
 * と読める形で出ること。配線は E2E でしか守れない。
 */
// 2 本とも同じ拠点の営業時間レコードを触るので、並行実行すると互いの version を
// 進めてしまう（実際にフレークした）。順に走らせる。
test.describe.configure({ mode: 'serial' });

// `branch-site` は seed 由来。dynamodb backend では seed が無視されるため実環境には無い
// （`admin-site-scope.spec.ts` と同じ理由）。
test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
);

test('ほかの管理者が先に保存していたら、上書きせず読み直しを促す', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto('/admin/operating-hours?siteId=branch-site');
  await expect(page.getByTestId('operating-hours-save')).toBeEnabled();

  // 画面が読んだ後に、別の管理者が保存した状況を作る。
  const current = await page.request.get('/api/admin/operating-policy?tenantId=internal&siteId=branch-site');
  expect(current.ok()).toBeTruthy();
  const { policy } = (await current.json()) as { policy: { version: number } | null };

  const other = await page.request.put('/api/admin/operating-policy', {
    data: {
      tenantId: 'internal',
      siteId: 'branch-site',
      timezone: 'Asia/Tokyo',
      weeklySchedule: { mon: [{ start: '09:00', end: '17:00' }] },
      fixedHolidays: [],
      exceptionDates: [],
      ...(policy ? { expectedVersion: policy.version } : {}),
    },
  });
  expect(other.ok(), 'ほかの管理者の保存が通っていない').toBeTruthy();

  // 画面はまだ古い版を持っている。ここで保存しても上書きさせない。
  await page.getByTestId('operating-hours-timezone').fill('Asia/Tokyo');
  await page.getByTestId('operating-hours-save').click();

  // 競合は「入力の誤り」ではないので専用の通知に出る。
  const conflict = page.getByTestId('operating-hours-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('保存していません');
  await expect(page.getByTestId('operating-hours-issues')).toHaveCount(0);
  // 行き止まりにしない。読み直す導線が押せる形で有ること。
  await expect(page.getByTestId('operating-hours-reload')).toBeVisible();

  // ほかの管理者の内容が残っていること（黙って消えていない）。
  const after = await page.request.get('/api/admin/operating-policy?tenantId=internal&siteId=branch-site');
  const body = (await after.json()) as { policy: { weeklySchedule: Record<string, unknown> } };
  expect(Object.keys(body.policy.weeklySchedule)).toEqual(['mon']);
});

test('競合していない通常の保存は通る（画面が読んだ版を送っている）', async ({ page }) => {
  // これが無いと、UI が `expectedVersion` を**送らなくなった**ときに気づけない。
  // 送らない実装でも既存レコードは常に 409 になるので、競合テストだけでは配線を縛れない。
  await loginAsAdmin(page);
  // 🔴 **既存レコードが有る状態で保存する。** 未設定の拠点だと「新規作成」になり、
  // `expectedVersion` を一度も通らないので、UI が送らなくなっても気づけない。
  const seeded = await page.request.put('/api/admin/operating-policy', {
    data: {
      tenantId: 'internal',
      siteId: 'branch-site',
      timezone: 'Asia/Tokyo',
      weeklySchedule: { mon: [{ start: '09:00', end: '18:00' }] },
      fixedHolidays: [],
      exceptionDates: [],
    },
  });
  // 既に有れば 409（それでよい。要るのは「レコードが存在すること」だけ）。
  expect([200, 409]).toContain(seeded.status());

  await page.goto('/admin/operating-hours?siteId=branch-site');
  await expect(page.getByTestId('operating-hours-save')).toBeEnabled();

  await page.getByTestId('operating-hours-timezone').fill('Asia/Tokyo');
  await page.getByTestId('operating-hours-save').click();

  // 🔴 **成功シグナルを見る。** `toHaveCount(0)` は PUT の応答が届く前（notice がまだ
  // 存在しない t=0）で通ってしまい、保存結果を一切見ていない。実際、UI から
  // `expectedVersion` を落とす変異が素通りしていた。
  await expect(page.getByTestId('operating-hours-saved')).toBeVisible();
  await expect(page.getByTestId('operating-hours-issues')).toHaveCount(0);
});
