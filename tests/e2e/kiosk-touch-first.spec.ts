import { test, expect, revealStaff } from './kiosk-fixtures';
import { openMoreIdleActions } from './helpers';

/**
 * タッチファースト受付導線の iPad viewport E2E (issue #121 / Epic #119 / #1057)。
 *
 * 初期画面に主要 CTA を大きなカードで提示し、音声・チャットなしでも定型 journey を
 * タッチだけで進めること、相手選択では software keyboard を出さないこと、状態に応じた
 * 逃げ道が出ることを検証する。
 */

test('初期画面に主要クイックアクションが大きなカードで表示される', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('quick-department')).toBeVisible();
  await expect(page.getByTestId('kiosk-more-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('start-checkin')).toBeHidden();
});

test('畳まれた入口は「ほかのご用件」を開くとタッチだけで到達できる (#620)', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
  await expect(page.getByTestId('start-checkin')).toBeVisible();
  await expect(page.getByTestId('quick-delivery')).toBeVisible();
  await expect(page.getByTestId('quick-other')).toBeVisible();
});

test('待機画面の指示は 1 系統（リードは安心情報のみで「開始」を二重指示しない）(#324)', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();
  const lead = page.getByTestId('idle-guidance');
  await expect(lead).toContainText('タッチ操作だけで受付できます');
  await expect(lead).not.toContainText('開始');
});

test('担当者を呼ぶ から 1 タップで目的選択へ進む（音声・チャット不要）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ご用件の種類をお選びください' })).toBeVisible();
  await expect(page.getByTestId('purpose-meeting')).toContainText('お約束の面会');
  await expect(page.getByTestId('purpose-delivery')).toContainText('お届け物');
});

test('配送・納品 は目的を先取りして担当/部署選択へ直行する', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
  await page.getByTestId('quick-delivery').click();
  // 文字検索欄ではなく、同じ selectingTarget のタッチUIへ直行する。
  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
});

test('相手選択の初期表示は判断対象を 1 種類に絞り、typing UI を出さない (#776/#1057)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.locator('[data-testid^="staff-staff-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="dept-"]')).toHaveCount(0);
  await expect(page.getByTestId('staff-search')).toHaveCount(0);

  // 主操作である部署群が初期 viewport 内にある。
  const groups = await page.getByTestId('staff-groups').boundingBox();
  const viewport = page.viewportSize();
  expect(groups).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(groups!.y).toBeLessThan(viewport!.height);
  expect(groups!.y + Math.min(groups!.height, 64)).toBeLessThan(viewport!.height);

  await page.getByTestId('target-tab-department').click();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
  await expect(page.locator('[data-testid^="staff-staff-"]')).toHaveCount(0);
  await page.getByTestId('dept-dept-sales').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
});

test('待機の「部署から選ぶ」は部署タブに着地する (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('quick-department').click();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
  await expect(page.getByTestId('target-tab-department')).toHaveAttribute('aria-selected', 'true');

  await page.getByTestId('target-tab-staff').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
});

test('相手選択のタブはキーボードでも操作でき、切替でフォーカスが迷子にならない (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  await page.getByTestId('target-tab-staff').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('target-tab-department')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'target-tab-department');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'target-tab-staff');
});

test('相手選択のタブと開いた部署は確認画面から戻っても勝手に変わらない (#776/#787)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('quick-department').click();
  await page.getByTestId('target-tab-staff').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
  await page.getByTestId('escape-back').click();

  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');
  // openStaffGroupId は KioskFlow が受付1回分保持するため、同じ担当者群へ戻る。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.getByTestId('staff-search')).toHaveCount(0);
});

test('探し方は受付 1 回で終わり、次の来訪者へ持ち越さない (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('quick-department').click();
  await expect(page.getByTestId('target-tab-department')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();

  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid^="dept-"]')).toHaveCount(0);
});

test('live region は同一ノードのまま部署の開閉を読み上げる (#776/#787)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  const live = page.getByTestId('target-live');
  await expect(live).toHaveText('');
  await live.evaluate((node) => node.setAttribute('data-liveness-probe', '1'));

  const group = page.locator('[data-testid^="staff-group-"][data-selectable]').first();
  await group.click();
  await expect(live).not.toBeEmpty();
  await expect(live).toHaveAttribute('data-liveness-probe', '1');

  await page.getByTestId('staff-group-back').click();
  await expect(live).toHaveText('');
  await expect(live).toHaveAttribute('data-liveness-probe', '1');
});

test('進行中の画面に常時見える逃げ道バーが出る', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
  await expect(page.getByTestId('escape-back')).toBeVisible();
  await expect(page.getByTestId('escape-reset')).toBeVisible();
  await expect(page.getByTestId('escape-cancel')).toHaveCount(0);
});

test('逃げ道の「最初に戻る」で待機画面へ戻れる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
});

/**
 * 群の開閉でフォーカスを連れて行く (#787)。
 * 押した要素自体が消える導線なので、放置するとフォーカスが body へ落ちる。
 */
test('部署の群を開閉してもフォーカスが迷子にならない (#787)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();

  const group = page.locator('[data-testid^="staff-group-"][data-selectable]').first();
  const groupTestId = await group.getAttribute('data-testid');
  await group.click();

  const focusedAfterOpen = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
  }));
  expect(focusedAfterOpen.tag, '群を開いたらフォーカスが body へ落ちた').not.toBe('BODY');
  expect(focusedAfterOpen.testid).toMatch(/^staff-staff-/);

  await expect(page.getByTestId('target-live')).not.toBeEmpty();

  await page.getByTestId('staff-group-back').click();
  const focusedAfterBack = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
  }));
  expect(focusedAfterBack.tag, '群を閉じたらフォーカスが body へ落ちた').not.toBe('BODY');
  expect(focusedAfterBack.testid).toBe(groupTestId);
});
