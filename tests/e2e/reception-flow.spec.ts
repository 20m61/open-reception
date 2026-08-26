import { test, expect, type Page, revealStaff } from './kiosk-fixtures';

/**
 * iPad 受付 MVP フローの E2E smoke test (issue #21)。
 * 成功 / 未応答 / 失敗の分岐と、完了後の待機画面復帰を検証する。
 *
 * 呼び出し結果は担当者の mockCallOutcome で決定的に分岐する (issue #20):
 *   staff-sato       → connected
 *   staff-suzuki     → timeout（未応答）
 *   staff-takahashi  → failed
 */

async function advanceToConfirm(page: Page, staffTestId: string, name = '来客 一郎', query = '') {
  await page.goto(`/kiosk${query}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, staffTestId);
  await page.getByTestId(staffTestId).click();
  await page.getByTestId('visitor-name').fill(name);
  await page.getByTestId('to-confirm').click();
  await expect(page.getByTestId('confirm-call')).toBeVisible();
}

test('呼び出し成功フロー: 接続 → 完了 → 待機画面へ復帰', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato');
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-connected')).toBeVisible();
  // 接続後は来訪者が操作不要なことを文言で示す (#324-5)。終了操作は任意。
  await expect(page.getByTestId('result-connected')).toContainText('操作は不要です');
  await page.getByTestId('complete').click();

  await expect(page.getByTestId('completed')).toBeVisible();
  // 自動リセットで待機画面へ戻る。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 10_000 });
});

test('接続画面は無操作で待機へ自動復帰する（「操作不要」案内と挙動を一致, #324）', async ({ page }) => {
  // connected は「操作は不要です」と案内する (#324-5)。指示どおり操作しないと、無操作タイムアウトで
  // 待機へ自動復帰し、前の来訪者のセッション（PII）を残して次の来訪者をブロックしないことを検証する。
  // 本番の connected 既定は 120s。E2E では connected **だけ**短縮する。
  // 一律の ?inactivityMs= だと、connected へ至る 6 ステップの操作も同じ短い上限に晒される。
  // 警告オーバーレイまでの猶予は limit が 10.5s 未満なら常に 500ms 固定なので、値を大きく
  // しても解決しない。1 ステップでもアニメーション待ちで遅れるとオーバーレイが click を
  // 横取りして落ちていた（負荷依存のフレーク, #476）。
  await page.goto('/kiosk?inactivityMs.connected=600');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();

  // 終了ボタンを押さず、そのまま無操作にする → 待機画面へ自動復帰する。
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 5_000 });
});

test('未応答フロー: timeout → 代替導線 → 待機画面へ復帰', async ({ page }) => {
  // タイムアウト直前の予告を挟んでから実遷移する (issue #323 AC3)。本番既定は予告保持を含め
  // 約 30s（Vonage の応答待ち上限と揃えた既定値）のため、E2E では ?callingNoticeMs= /
  // ?callingNoticeHoldMs= で短縮する（既存 ?inactivityMs= と同じ流儀）。
  await advanceToConfirm(
    page,
    'staff-staff-suzuki',
    '来客 一郎',
    '?callingStageMs=100&callingNoticeMs=200&callingNoticeHoldMs=100',
  );
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible();
  await page.getByTestId('use-fallback').click();
  await expect(page.getByTestId('fallback')).toBeVisible();

  // 後退（最初に戻る）は逃げ道バーへ一本化 (#325)。コンテンツ内の fallback-reset は撤去済み。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('失敗フロー: failed でも代替導線で詰まらない', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-takahashi');
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-failed')).toBeVisible();
  // 結果画面の最初に戻るは逃げ道バー（escape-reset）へ一本化 (#325)。
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('start-reception')).toBeVisible();
});

test('部署選択でも呼び出しできる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-delivery').click();
  // 部署グリッドは常時表示ではなく「部署から選ぶ」タブの中にある (#776)。
  await page.getByTestId('target-tab-department').click();
  await page.getByTestId('dept-dept-sales').click();
  await page.getByTestId('visitor-name').fill('配送 太郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
});

test('担当者検索で絞り込める', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-search').fill('すずき');
  await revealStaff(page, 'staff-staff-suzuki');
  await expect(page.getByTestId('staff-staff-suzuki')).toBeVisible();
  await expect(page.getByTestId('staff-staff-sato')).toHaveCount(0);
});

test('1 文字 typo でも「もしかして」候補として見つかる (#322)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // 「たかはし」の 1 文字 typo。従来の完全部分一致では 0 件だった。
  await page.getByTestId('staff-search').fill('たかばし');
  await revealStaff(page, 'staff-staff-takahashi');
  await expect(page.getByTestId('staff-staff-takahashi')).toBeVisible();
  await revealStaff(page, 'staff-staff-takahashi-maybe');
  await expect(page.getByTestId('staff-staff-takahashi-maybe')).toBeVisible();
  // 0 件時の誘導は出ない（ヒットしているため）。
  await expect(page.getByTestId('target-recovery')).toHaveCount(0);
});

test('検索 0 件でも行き止まりにならず、部署一覧・チャット相談への導線が出る (#322 AC3)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-search').fill('存在しない名前です');

  // 警告と案内を 2 枚重ねず、recovery パネル 1 枚に集約する (#776)。
  const recovery = page.getByTestId('target-recovery');
  await expect(recovery).toBeVisible();
  await expect(page.getByTestId('staff-empty')).toHaveCount(0);
  await expect(page.getByTestId('search-no-results-guidance')).toHaveCount(0);

  // 次の一手 1: 1 操作で部署タブへ切り替わる（スクロール誘導ではない）。
  await page.getByTestId('target-recovery-department-cta').click();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
  await expect(recovery).toHaveCount(0);

  // 次の一手 2: チャットで受付係に相談する（Chat-assisted ドロワーが開く）。
  await page.getByTestId('target-tab-staff').click();
  await expect(recovery).toBeVisible();
  await page.getByTestId('target-recovery-chat-cta').click();
  await expect(page.getByTestId('kiosk-chat-drawer')).toHaveAttribute('data-open', 'true');
});

test('確認画面から修正に戻れる', async ({ page }) => {
  await advanceToConfirm(page, 'staff-staff-sato', '修正 花子');
  await expect(page.getByTestId('confirm-name')).toHaveText('修正 花子');
  await page.getByTestId('confirm-back').click();
  await expect(page.getByTestId('visitor-name')).toHaveValue('修正 花子');
});
