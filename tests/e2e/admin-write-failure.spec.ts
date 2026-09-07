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
type FailMode = '500' | 'abort' | 'broken-200' | 'slow';

async function failWrites(page: Page, pattern: string, mode: FailMode): Promise<void> {
  await page.route(pattern, async (route) => {
    // 読み取り（GET）は通す。書き込みだけ落とすことで「読めているのに書けない」を作る。
    if (route.request().method() === 'GET') return route.continue();
    if (mode === '500') {
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
    }
    if (mode === 'broken-200') {
      // 🔴 **200 だが本文が壊れている。** プロキシによる切断・`Content-Length` 途中終了で
      // 実際に起こる。`abort` と `500` だけ注入していると、この経路（`unreadable`）を
      // **一度も踏まない**（独立レビュー 2 周目 MAJOR-D の実測）。
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"' });
    }
    if (mode === 'slow') {
      /*
        🔴 **応答を返さない**（`abort` すら遅らせて返す、ではない）。キャプティブポータル・
        half-open TCP・LB のブラックホールで実際に起きる形で、**締切が無いと画面が
        恒久的に固まる**。遅延して abort する書き方にすると、締切を消す変異が
        素通りする（実測で確認した）。ハンドラは解決させないまま置く。
      */
      return new Promise(() => {});
    }
    return route.abort('failed');
  });
}

/** 読み取りも書き込みも落とす（「保存はしたが取り直せない」を作るため）。 */
async function failAll(page: Page, pattern: string): Promise<void> {
  await page.route(pattern, (route) => route.abort('failed'));
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

  /**
   * 応答は 200 なのに本文が読めない経路 (#973)。`abort` / `500` だけでは踏めない。
   * ここで見るのは「通信を疑わせない別の文言が出ること」である。
   */
  test('音声設定: 200 だが本文が壊れているとき、通信のせいにしない (#973)', async ({ page }) => {
    await page.goto('/admin/voice');
    await expect(page.getByTestId('voice-save')).toBeVisible();
    await failWrites(page, '**/api/admin/voice**', 'broken-200');

    await page.getByTestId('voice-save').click();

    const error = page.getByTestId('voice-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('読み取れませんでした');
    await expect(error).not.toContainText('接続できませんでした');
  });

  /**
   * 送信中の窓 (#973)。冒頭で確認ボタンを閉じるので、何も出ないと**やめたのと区別が
   * 付かない**。オフラインの iPad では reject まで数十秒かかる。
   */
  test('緊急停止: 送信中は無言にならず、二度押しもできない (#973)', async ({ page }) => {
    // 締切（10s）を跨ぐので既定の 30s では余裕が薄い。retries に吸収させない。
    test.setTimeout(60_000);
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', 'slow');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    await expect(page.getByTestId('emergency-pending')).toBeVisible();
    // 送信中は押し直せない（重複した停止要求を投げさせない）。確認ボタンは押した時点で
    // **DOM ごと消える**ので、無効化を見るのは残っているほうのボタンである。
    await expect(page.getByTestId('emergency-confirm')).toHaveCount(0);
    await expect(page.getByTestId('emergency-stop')).toBeDisabled();
    // 🔴 **「処理中」に「押せない」の見た目を当てない**（`docs/experience/README.md`）。
    // `aria-busy` が無いと危険色が消えて破線になり、「タップが失敗した」と読まれる。
    await expect(page.getByTestId('emergency-stop')).toHaveAttribute('data-state', 'busy');
    // 窓が閉じたら必ず戻る（締切があるので、応答が返らなくても固まらない）。
    await expect(page.getByTestId('emergency-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('emergency-stop')).toBeEnabled();
  });

  /**
   * 🔴 **GET も落とす。** `failWrites` は GET を通すので、書き込み後の再取得が必ず成功し、
   * 「保存はしたが表示を取り直せない」経路を一度も踏めない（独立レビュー 2 周目 MAJOR-D）。
   * 緊急停止は**応答本体でトグルを更新する**ので、GET が死んでいても結論は変わらない
   * ことをここで固定する（`load()` で取り直す実装へ戻すと、この 1 本が落ちる）。
   */
  test('緊急停止: 読み取りごと落ちていても、届かなかったことを言い切る (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failAll(page, '**/api/admin/security**');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    const error = page.getByTestId('emergency-error');
    await expect(error).toBeVisible();
    // 「保存できたか分かりません」が残っていること（「表示が古いかも」で上書きしない）。
    await expect(error).toContainText('分かりません');
  });

  /**
   * 宛先ラベル (#973)。拠点別の画面は保存が飛行中に切り替えられるので、
   * **どの拠点の話か**が文言に無いと B を見ている運用者が誤って安心する。
   */
  test('サイネージ: 失敗の文言に拠点が入る (#973)', async ({ page }) => {
    await page.goto('/admin/signage');
    await expect(page.getByTestId('signage-save')).toBeVisible();
    const label = await page
      .getByTestId('signage-site-select')
      .evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '');
    expect(label, '拠点セレクタに選択が無い（下界）').toBeTruthy();
    await failWrites(page, '**/api/admin/signage**', 'abort');

    await page.getByTestId('signage-save').click();

    const error = page.getByTestId('signage-save-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText(label);
  });

  test('営業時間: 失敗の文言に拠点が入る (#973)', async ({ page }) => {
    await page.goto('/admin/operating-hours');
    await expect(page.getByTestId('operating-hours-save')).toBeVisible();
    // 選択中の option の表示名＝画面に出るはずの宛先（`siteLabel` は name、無ければ id）。
    // `option:checked` は Playwright の CSS エンジンで解決できない（実測でタイムアウト）。
    const label = await page
      .getByTestId('operating-hours-site-select')
      .evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '');
    expect(label, '拠点セレクタに選択が無い（下界）').toBeTruthy();
    await failWrites(page, '**/api/admin/operating-policy**', 'abort');

    await page.getByTestId('operating-hours-save').click();

    const error = page.getByTestId('operating-hours-error');
    await expect(error).toBeVisible();
    // **これが本題。** 宛先が無いと、切替後の運用者が他拠点の失敗を自分の話として読む。
    await expect(error).toContainText(label);
  });

  /**
   * 200 だが本文が読めなかったときの緊急停止 (#973)。**適用はされている**ので失敗とは
   * 言わず、「反映できなかったのは表示のほう」だと言う。
   */
  test('緊急停止: 200 でも結果を確認できなければ「有効にしました」と言わない (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', 'broken-200');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    // **これが本題。** 200 は受理だが、返ってきた状態を確認できていない。断定しない。
    await expect(page.getByTestId('emergency-error')).toBeVisible();
    await expect(page.getByTestId('emergency-saved')).toHaveCount(0);
    // 表示が当てにならないことと、取り直す導線。
    await expect(page.getByTestId('security-view-stale')).toBeVisible();
    await expect(page.getByTestId('security-view-reload')).toBeVisible();
  });

  /**
   * 🔴 **同じ条件に別の結論を出さない** (#973)。フォーム保存も緊急停止も同じ
   * `PUT /api/admin/security` を叩く。片方だけ「読めなかった 200 は成功」にすると、
   * 押したボタンで意味が変わる画面になる（3 周目 MAJOR-1 の根拠 3）。
   */
  test('セキュリティ設定: 200 で本文が読めないとき、保存も成功と言わない (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('security-save')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', 'broken-200');

    await page.getByTestId('security-save').click();

    await expect(page.getByTestId('security-error')).toBeVisible();
    await expect(page.getByTestId('security-saved')).toHaveCount(0);
    await expect(page.getByTestId('security-view-stale')).toBeVisible();
  });

  /**
   * 🔴 **設定保存の往復が、緊急停止を塞がない** (#973)。
   *
   * 3 周目で同時飛行を塞ごうとして緊急停止のボタンに `busy` を足したが、`save` には
   * 締切が無いので `busy` は有界でない —— **保存を 1 回押しただけで、通信が半死の間ずっと
   * 受付を止められなくなる**。受付を止める操作が設定保存の都合で塞がってはいけない。
   */
  test('保存が返ってこなくても、緊急停止は押せる (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('security-save')).toBeVisible();
    await failWrites(page, '**/api/admin/security**', 'slow');

    await page.getByTestId('security-save').click();
    // 保存は往復中（ラベルが変わる＝処理中が見えている）。
    await expect(page.getByTestId('security-save')).toContainText('保存中');

    // **これが本題。** 保存が返らなくても緊急停止は押せる。
    await expect(page.getByTestId('emergency-stop')).toBeEnabled();
  });

  /**
   * 🔴 **新設した「取り直す」が黙って失敗しない** (#973)。
   * `loadFailed` は `if (!view)` の枝にしか出ないので、報告を足さないと
   * **「押しても何も起きない導線」をこの PR が新設する**ことになる。
   */
  test('取り直すが失敗したら、そう言う (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-stop')).toBeVisible();
    await failAll(page, '**/api/admin/security**');

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();
    await expect(page.getByTestId('emergency-error')).toBeVisible();

    const reload = page.getByTestId('security-view-reload');
    await expect(reload).toBeVisible();
    await reload.click();

    await expect(page.getByTestId('security-view-reload-error')).toBeVisible();
    await expect(page.getByTestId('security-view-reload-error')).toHaveAttribute('role', 'alert');
    // 押し直せる状態に戻る。
    await expect(reload).toBeEnabled();
  });

  /**
   * 🔴 **「取り直す」が編集中の入力を捨てない** (#973)。
   *
   * この導線を置いた理由は「導線が無いとブラウザごと再読み込みするしかなく、編集中の
   * IP 許可リストを捨てることになる」だった。表示だけ取り直す（`applyView` を呼ばない）
   * ようにしていないと、ボタン自身がその理由を破る。
   */
  test('取り直すは編集中の入力を捨てない (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('security-ip')).toBeVisible();
    await page.getByTestId('security-ip').fill('203.0.113.99');

    // 書き込みだけ壊す（GET は通るので、取り直しは成功する）。
    await failWrites(page, '**/api/admin/security**', 'broken-200');
    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();
    await expect(page.getByTestId('security-view-stale')).toBeVisible();

    await page.getByTestId('security-view-reload').click();
    // 取り直しは成功したので、注意書きは消える。
    await expect(page.getByTestId('security-view-stale')).toHaveCount(0);
    // **これが本題。** 打ち込んだ値は残っている。
    await expect(page.getByTestId('security-ip')).toHaveValue('203.0.113.99');
  });

  /**
   * 🔴 **形の壊れた 200 も同じ扱い。** `{"ok":true}` は `res.json()` を通るので、
   * `as SecurityView` で受けるとトグルが `undefined` になり、画面は
   * 「現在: 通常稼働」と「緊急停止を有効にしました」を**同時に**出す（3 周目 MAJOR-1）。
   */
  const MALFORMED_BODIES = [
    // まったく別物（バージョンスキュー・企業プロキシの応答）。
    { name: '別の形', body: '{"ok":true}' },
    /*
      🔴 **1 フィールドだけ欠けた形**。全部欠けた本文だと、述語のどのチェックを外しても
      別のチェックが拾ってしまい、**述語を弱める変異が生存する**（実測 P1）。
      境界のすぐ内側を踏む入力が要る、という `.claude/rules` の指摘と同型。
    */
    {
      name: 'emergencyStop だけ欠けた形',
      body: '{"pinRequired":false,"ipAllowlist":[],"pinConfigured":false}',
    },
  ] as const;

  for (const malformed of MALFORMED_BODIES) {
    test(`緊急停止: 形の違う 200（${malformed.name}）を状態として載せない (#973)`, async ({ page }) => {
      await page.goto('/admin/security');
      await expect(page.getByTestId('emergency-stop')).toBeVisible();
      await page.route('**/api/admin/security**', (route) => {
        if (route.request().method() === 'GET') return route.continue();
        return route.fulfill({ status: 200, contentType: 'application/json', body: malformed.body });
      });

      await page.getByTestId('emergency-stop').click();
      await page.getByTestId('emergency-confirm').click();

      await expect(page.getByTestId('emergency-error')).toBeVisible();
      await expect(page.getByTestId('emergency-saved')).toHaveCount(0);
      // トグルは古い値のまま（`undefined` を載せて「通常稼働」に化けさせない）。
      await expect(page.getByTestId('emergency-state')).toContainText('通常稼働');
    });
  }

  /**
   * 🔴 **成功経路の証拠** (#973)。ここまでの注入は全部失敗側で、`setView(applied)` を
   * 落とす変異が素通りしていた（3 周目 MAJOR-1）。応答を注入で返すので共有 seed は変えない。
   */
  test('緊急停止: 応答本体でトグルが更新される (#973)', async ({ page }) => {
    await page.goto('/admin/security');
    await expect(page.getByTestId('emergency-state')).toContainText('通常稼働');
    await page.route('**/api/admin/security**', (route) => {
      if (route.request().method() === 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pinRequired: false,
          ipAllowlist: [],
          pinConfigured: false,
          emergencyStop: true,
        }),
      });
    });

    await page.getByTestId('emergency-stop').click();
    await page.getByTestId('emergency-confirm').click();

    await expect(page.getByTestId('emergency-saved')).toBeVisible();
    // **これが本題。** 取り直さずに、返ってきた状態がそのままトグルになる。
    await expect(page.getByTestId('emergency-state')).toContainText('停止中');
    await expect(page.getByTestId('emergency-resume')).toBeVisible();
    await expect(page.getByTestId('security-view-stale')).toHaveCount(0);
  });

  /**
   * 🔴 **飛行中に拠点を切り替えても、報告は消えない** (#973)。
   *
   * 応答の直後で `if (!isCurrentScope(startedWith)) return;` していたときは、
   * **成功も失敗も丸ごと飲み込まれた** —— A の保存が 409 / 400 で失敗しても画面に何も
   * 出ず、運用者は A が保存されたと信じる。門はフォームへ書く行だけに掛ける。
   */
  test.describe('拠点を切り替えても報告が消えない (#973)', () => {
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    /*
      🔴 **サイネージ側は e2e で踏めない**（正直に書く）。`signage-site-select` は
      `disabled={sitePending || busy}` なので、保存中は拠点セレクタから切り替えられない。
      この画面で飛行中の切替が起こるのは **TenantSwitcher による `router.refresh()`**
      （同 manager が再利用され、同じ拠点 ID を持つ別テナントとして A の応答が B へ載る）
      だけで、そこを e2e で駆動するには別の足場が要る。営業時間側（セレクタが
      `disabled={sitePending}` だけ）で同じ性質を縛り、変異もそちらで測った。
    */

    /**
     * 🔴 **応答が「切り替えた後に」届く経路。** これが門の広さを踏む唯一の形である。
     * 門を応答の直後に置くと、A の 500 / 409 / 400 が**丸ごと飲み込まれ**、運用者は
     * A が保存されたと信じたまま B の画面を見る（独立レビュー 2 周目 MAJOR-C）。
     */
    test('営業時間: 切り替えた後に届いた失敗も報告される', async ({ page }) => {
      await page.goto('/admin/operating-hours');
      await expect(page.getByTestId('operating-hours-save')).toBeVisible();

      // PUT を保留し、切替を挟んでから 500 を返す（GET は通すので切替先は表示できる）。
      let release: (() => void) | undefined;
      const held = new Promise<void>((r) => {
        release = r;
      });
      await page.route('**/api/admin/operating-policy**', async (route) => {
        if (route.request().method() === 'GET') return route.continue();
        await held;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
      });

      await page.getByTestId('operating-hours-save').click();
      await page.getByTestId('operating-hours-site-select').selectOption('branch-site');
      await expect(page).toHaveURL(/siteId=branch-site/);
      release?.();

      // **これが本題。** 門が広いとここで何も出ない。
      await expect(page.getByTestId('operating-hours-error')).toBeVisible();
    });

    /**
     * 切替先の取得も失敗する経路。フォームごと差し替わるので、`SaveFeedback` が
     * 差し替え枝にも無いと**直前の失敗が永久に描画されない**。
     */
    test('営業時間: 切替先の取得が失敗しても、直前の失敗が消えない', async ({ page }) => {
      await page.goto('/admin/operating-hours');
      await expect(page.getByTestId('operating-hours-save')).toBeVisible();

      // 以後は読み取りも書き込みも落とす（初回描画は済んでいる）。
      await failAll(page, '**/api/admin/operating-policy**');

      await page.getByTestId('operating-hours-save').click();
      const error = page.getByTestId('operating-hours-error');
      await expect(error).toBeVisible();

      await page.getByTestId('operating-hours-site-select').selectOption('branch-site');
      // 切替先の取得が落ちるので、フォームは差し替え枝になる。
      await expect(page.getByTestId('operating-hours-unavailable')).toBeVisible();
      // **これが本題。** 差し替え枝に SaveFeedback が無いと、ここで消える。
      await expect(error).toBeVisible();
    });
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
