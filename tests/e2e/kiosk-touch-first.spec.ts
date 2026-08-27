import { test, expect, revealStaff } from './kiosk-fixtures';
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
  //
  // 初期表示は担当者を絞るための**群**（#787）。ここで `revealStaff` を挟むと
  // 「初期表示を見る」という本テストの主題が消えるので、挟まない。
  await expect(page.getByTestId('staff-groups')).toBeVisible();
  await expect(page.locator('[data-testid^="staff-staff-"]')).toHaveCount(0);
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

test('待機の「部署から選ぶ」は部署タブに着地する (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  // 押した導線と着いた画面を一致させる。担当者タブに着くと、部署名しか知らない来訪者が
  // 名前検索欄の前に置き去りになる。
  await page.getByTestId('quick-department').click();
  await expect(page.getByTestId('dept-dept-sales')).toBeVisible();
  await expect(page.getByTestId('target-tab-department')).toHaveAttribute('aria-selected', 'true');
  // 担当者へも 1 タップで移れる（着地を変えただけで、もう一方を塞いでいない）。
  await page.getByTestId('target-tab-staff').click();
  await expect(page.getByTestId('staff-search')).toBeVisible();
});

test('相手選択のタブはキーボードでも操作でき、切替でフォーカスが迷子にならない (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();

  // `role="tab"` を名乗る以上、左右キーでの移動は契約 (WAI-ARIA APG)。
  await page.getByTestId('target-tab-staff').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('target-tab-department')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'target-tab-department');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');

  // recovery の CTA でタブを切り替えると押した要素自体が消える。フォーカスを移さないと
  // body へ落ち、支援技術には何も起きなかったように見える。
  await page.getByTestId('staff-search').fill('存在しない名前です');
  await page.getByTestId('target-recovery-department-cta').click();
  await expect(page.locator(':focus')).toHaveAttribute('data-testid', 'target-tab-department');
});

test('相手選択のタブは確認画面から戻っても勝手に切り替わらない (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  // 「部署から選ぶ」で入ったあと担当者タブへ移り、担当者を選んで戻る。
  await page.getByTestId('quick-department').click();
  await page.getByTestId('target-tab-staff').click();
  // 担当者タブの初期表示は部署の群 (#787)。担当者カードは群を開かないと出ない。
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await expect(page.getByTestId('visitor-name')).toBeVisible();
  await page.getByTestId('escape-back').click();
  // 入口が部署でも、来訪者が最後に選んだ探し方のまま戻る。
  await expect(page.getByTestId('target-tab-staff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('staff-search')).toBeVisible();
});

test('探し方は受付 1 回で終わり、次の来訪者へ持ち越さない (#776)', async ({ page }) => {
  // iPad は常設端末で再読み込みされない。前の来訪者が「部署から選ぶ」で入ったことが
  // 次の来訪者の着地先を変えると、押した導線と着いた画面が食い違う。
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

test('0 件になったことが支援技術へ伝わる (#776)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  // live region は候補が有るうちから存在する（変化の前から在らないと読み上げられない）。
  const live = page.getByTestId('target-live');
  await expect(live).toHaveText('');
  // **存在するだけでは足りない**。同じノードのまま中身が変わることまで縛る。要素ごと
  // 作り直されると「内容を持った状態で挿入」になり、live region は読み上げない。
  // React は自分が管理しない属性を上書きしないので、印を打って生存を見る。
  await live.evaluate((node) => node.setAttribute('data-liveness-probe', '1'));

  await page.getByTestId('staff-search').fill('存在しない名前です');
  await expect(live).toContainText('お探しの方が見つかりませんでした');
  await expect(live).toHaveAttribute('data-liveness-probe', '1');

  // 候補が戻れば静かになる（空文字の書き込みは読み上げられない）。ノードは生きたまま。
  await page.getByTestId('staff-search').fill('さとう');
  await expect(live).toHaveText('');
  await expect(live).toHaveAttribute('data-liveness-probe', '1');
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

/**
 * 群の開閉でフォーカスを連れて行く (#787)。
 *
 * 🔴 **押した要素自体が消える導線**なので、放置するとフォーカスが body へ落ち、
 * 支援技術には**何も起きなかったように見える**（独立レビューが実測で検出）。
 * このファイルは #776 でタブに対してまったく同じ欠陥を直しており（`switchTab`）、
 * 新導線にその対策が入っていなかった。axe は焦点喪失を検出しないので、ここで縛る。
 */
test('部署の群を開閉してもフォーカスが迷子にならない (#787)', async ({ page }) => {
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();

  const group = page.locator('[data-testid^="staff-group-"][data-selectable]').first();
  const groupTestId = await group.getAttribute('data-testid');
  await group.click();

  // 開いたら中身の先頭へ。body へ落とさない。
  const focusedAfterOpen = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
  }));
  expect(focusedAfterOpen.tag, '群を開いたらフォーカスが body へ落ちた').not.toBe('BODY');
  expect(focusedAfterOpen.testid).toMatch(/^staff-staff-/);

  // 何が起きたかを読み上げる（見えている変化を支援技術にも届ける）。
  await expect(page.getByTestId('target-live')).not.toBeEmpty();

  await page.getByTestId('staff-group-back').click();
  // 閉じたら**開く前に押した群カード**へ戻す。先頭へ飛ばすと、どこに居たか分からなくなる。
  const focusedAfterBack = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? null,
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
  }));
  expect(focusedAfterBack.tag, '群を閉じたらフォーカスが body へ落ちた').not.toBe('BODY');
  expect(focusedAfterBack.testid).toBe(groupTestId);
});

/**
 * 逃げ道バーの下にコンテンツを取り残さない (#787)。
 *
 * 🔴 **スクリーンショットでは見えない欠陥。** バーは不透明なので、覆われた部分は
 * 「カードが途中で切れている」ようにしか見えない。押した結果が変わるのは**見えない領域**
 * なので誤操作には直結しないが、#124 が「バーがスクロール内容に隠れないようにする」と
 * 決めた裏返し ―― 内容がバーに隠れる ―― は塞がっていなかった。
 *
 * 判定は VRT ではなく**ヒットテスト**で行う。1024x768（iPad 9.7"/mini の横向き）は
 * カードが 2 行に折り返して最も高くなる構成で、独立レビューが実測で踏んだ viewport。
 */
test('逃げ道バーが最後のカードを覆わない (#787)', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await expect(page.getByTestId('staff-groups')).toBeVisible();

  /*
   * 🔴 **最下部まで送ってから見る。** 余白が保証するのは「**スクロールすれば必ず出てくる**」
   * ことであって、初期位置で重ならないことではない（sticky なバーは、スクロールできる限り
   * 内容の上に乗る ―― それが sticky の役目でもある）。初期位置で判定すると、内容が増えた
   * だけで落ちる**主張しすぎのオラクル**になる。実際それで一度落とした。
   */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);

  const covered = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="kiosk-escape-bar"]')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid^="staff-group-"][data-selectable]')];
    return cards
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-testid'), overlap: Math.round(r.bottom - bar.top) };
      })
      .filter((c) => c.overlap > 0);
  });
  expect(
    covered,
    `最下部まで送っても逃げ道バーがカードを覆っている: ${JSON.stringify(covered)}`,
  ).toEqual([]);
});
