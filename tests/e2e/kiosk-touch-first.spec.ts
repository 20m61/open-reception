import { test, expect } from './kiosk-fixtures';
import { openMoreIdleActions } from './helpers';

/**
 * タッチファースト受付導線の iPad viewport E2E (issue #121 / Epic #119)。
 *
 * 初期画面に主要 CTA を大きなカードで提示し、音声・チャットなしでタッチだけで主要受付
 * パターンへ 1 タップで進めること、状態に応じた逃げ道（戻る/キャンセル等）が出ることを検証する。
 * ボタン集合・操作可否の真実源は #120 の UX 契約（ユニット: src/components/kiosk/quick-actions.test.ts）。
 */

test('初期画面に主要クイックアクションが大きなカードで表示される', async ({ page }) => {
  await page.goto('/kiosk');
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
  // 主要 2 枚は開示を開かずに押せる（担当者を呼ぶ は後方互換 testid）。
  await expect(page.getByTestId('start-reception')).toBeVisible();
  await expect(page.getByTestId('quick-department')).toBeVisible();
  // 残りは畳まれている。**「無い」ではなく「隠れている」**ことを支援技術に伝える (#620)。
  await expect(page.getByTestId('kiosk-more-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('start-checkin')).toBeHidden();
});

test('畳まれた入口は「ほかのご用件」を開くとタッチだけで到達できる (#620)', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
  // QR 受付 / 配送・納品 / その他。押したときに起こることは畳む前と変えていない。
  await expect(page.getByTestId('start-checkin')).toBeVisible();
  await expect(page.getByTestId('quick-delivery')).toBeVisible();
  await expect(page.getByTestId('quick-other')).toBeVisible();
});

test('待機画面の指示は 1 系統（リードは安心情報のみで「開始」を二重指示しない）(#324)', async ({ page }) => {
  await page.goto('/kiosk');
  // 見出しは唯一の主指示「ご用件をお選びください」。
  await expect(page.getByRole('heading', { name: 'ご用件をお選びください' })).toBeVisible();
  // リード（idle-guidance）は挨拶＋「タッチだけで受付できる」安心情報のみ。「開始」の再指示を出さない。
  const lead = page.getByTestId('idle-guidance');
  await expect(lead).toContainText('タッチ操作だけで受付できます');
  await expect(lead).not.toContainText('開始');
});

test('担当者を呼ぶ から 1 タップで目的選択へ進む（音声・チャット不要）', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await expect(page.getByTestId('purpose-meeting')).toBeVisible();
  // 待機見出しと同一文言で再質問せず、「種類の絞り込み」として提示する (#324-2)。
  await expect(page.getByRole('heading', { name: 'ご用件の種類をお選びください' })).toBeVisible();
  // 目的カードは待機カードと同様にアイコン＋説明を持つ（視覚語彙の統一, #324-3）。
  await expect(page.getByTestId('purpose-meeting')).toContainText('お約束の面会');
  await expect(page.getByTestId('purpose-delivery')).toContainText('お届け物');
});

test('配送・納品 は目的を先取りして担当/部署選択へ直行する', async ({ page }) => {
  await page.goto('/kiosk');
  await openMoreIdleActions(page);
  await page.getByTestId('quick-delivery').click();
  // 目的選択をスキップし、担当者・部署選択へ進む（担当者検索欄の出現で判定）。
  await expect(page.getByTestId('staff-search')).toBeVisible();
});

test('相手選択の初期表示は判断対象を 1 種類に絞る (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // 担当者グリッドと部署グリッドを縦に連続表示しない。**DOM に無い**ことまで見る
  // （`toBeHidden` だと「下にあるだけ」の退行を通してしまう）。
  await expect(page.getByTestId('staff-staff-sato')).toBeVisible();
  await expect(page.locator('[data-testid^="dept-"]')).toHaveCount(0);
  // 主操作（検索欄）はスクロールせずに見える位置にある。
  const search = await page.getByTestId('staff-search').boundingBox();
  const viewport = page.viewportSize();
  expect(search).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(search!.y + search!.height).toBeLessThan(viewport!.height);
  // 候補グリッドは 1 つだけ（0 件案内と候補一覧が同時に出ない、も含む）。
  await expect(page.locator('.card-grid')).toHaveCount(1);

  // 部署へはタッチだけで 1 タップ到達でき、そのとき担当者グリッドは消える。
  await page.getByTestId('target-tab-department').click();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
  await expect(page.locator('[data-testid^="staff-staff-"]')).toHaveCount(0);
  await page.getByTestId('dept-dept-sales').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
});

test('進行中の画面に常時見える逃げ道バーが出る', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // selectingTarget では 戻る・最初に戻る の逃げ道が常設される（内容が長くても常時可視）(#325)。
  await expect(page.getByTestId('kiosk-escape-bar')).toBeVisible();
  await expect(page.getByTestId('escape-back')).toBeVisible();
  await expect(page.getByTestId('escape-reset')).toBeVisible();
  // 後退語彙は 戻る/最初に戻る の 2 語に集約（キャンセルは出さない）。
  await expect(page.getByTestId('escape-cancel')).toHaveCount(0);
});

test('逃げ道の「最初に戻る」で待機画面へ戻れる', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('escape-reset').click();
  await expect(page.getByTestId('kiosk-quick-actions')).toBeVisible();
});
