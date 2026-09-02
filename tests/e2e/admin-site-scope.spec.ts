// **kiosk-fixtures からは import しない。** あちらの `test` は毎テスト
// `establishKioskSession` を走らせ、端末を 1 台作ってエンロールしたまま消さない。
// この spec は管理画面の読み取りだけなのに、実行のたびに端末が増え、しかも
// **その端末一覧を assert している**（自分で汚した対象を検査することになる）。
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from './helpers';

/**
 * 拠点スコープが URL で表現されることの実 UI 検証 (#421)。
 *
 * 純関数側（`site-scope.test.ts`）は解決規則を固定しているが、**実際に URL から読まれて
 * セレクタへ反映されるか**は配線の話なので unit では見えない。第 87 wave で
 * 「純関数は正しいのに配線が stale」という同型の欠陥を踏んでいるため、実ルートで見る。
 *
 * **なぜ seed に 2 拠点目が要るか**（`src/lib/tenant/store.ts` の `branch-site`）:
 * 拠点が 1 件だと、**URL を一切見ない実装（先頭サイトを自動選択）でも同じ結果になる**ため、
 * ここに書くテストは何をしても pass する＝検証になっていない。増分 1 で実際にそうなった
 * （2 本とも変更前から pass していた）。2 件目を置いて初めて「切り替えが URL に載り、
 * リロードで保たれる」を実証できる。
 *
 * 既存 spec への影響が無いことは確認済み: 拠点を触る e2e は全て `default-site` を明示指定し、
 * `capture-screens.spec.ts` は `page.screenshot()` で撮るだけ（VRT 比較をしない）。
 */
test.describe('管理: 拠点スコープが URL に載る (#421)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('URL の siteId が拠点セレクタへ反映される', async ({ page }) => {
    await page.goto('/admin/devices?siteId=default-site');

    // testid で名指しする。`locator('select').first()` だと、複数テナントに所属する
    // 管理者ではヘッダの TenantSwitcher が先に出て**テナント選択の方を掴む**。
    await expect(page.getByTestId('device-site-select')).toHaveValue('default-site');
  });

  test('拠点を切り替えると URL に載り、リロードしても保たれる', async ({ page }) => {
    // **実環境 URL 実行では落とす。** `branch-site` は `store.ts` の SEED 由来だが、
    // **dynamodb backend は seed を無視する**（`data-repository.ts` の CollectionOpts 契約）。
    // 投入経路は `npm run seed:dynamodb` だけで、これは初期プロビジョニング時にしか走らない。
    // よって既存デプロイ環境には `branch-site` が無く、selectOption がタイムアウトする。
    // これは実環境の欠陥ではなく実行方法の欠陥なので、`playwright.config.ts` が
    // platform project を remote 実行から外しているのと同じ判断で skip する。
    // （実環境でも確認したい場合は `seed:dynamodb` を再実行すれば投入される。同じ SEED を共有。）
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    // **これが「URL が真実源」であることの実証。** 拠点が 1 件しか無いと、URL を一切見ない
    // 旧実装（先頭サイトを自動選択）でも同じ結果になり検証にならないため、seed に 2 件目
    // （`branch-site`）を置いてある。
    await page.goto('/admin/devices');
    const select = page.getByTestId('device-site-select');
    await expect(select).toHaveValue('default-site');

    await select.selectOption('branch-site');
    await expect(page).toHaveURL(/siteId=branch-site/);
    await expect(select).toHaveValue('branch-site');

    // リロードしても選択が戻らない（component state だった頃はここで先頭へ戻っていた）。
    await page.reload();
    await expect(page.getByTestId('device-site-select')).toHaveValue('branch-site');
  });

  test('営業時間も拠点を切り替えられ、URL に載る', async ({ page }) => {
    // 以前この画面は resolveDefaultScope() に**固定**で、UI から別拠点の営業時間へ到達する
    // 手段が無かった（env でしか変えられない）。#421「拠点詳細から全関連設定へ到達」は
    // ここが直らないと成立しない。
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    await page.goto('/admin/operating-hours');
    const select = page.getByTestId('operating-hours-site-select');
    await expect(select).toHaveValue('default-site');

    await select.selectOption('branch-site');
    await expect(page).toHaveURL(/siteId=branch-site/);

    await page.reload();
    await expect(page.getByTestId('operating-hours-site-select')).toHaveValue('branch-site');
  });

  for (const screen of [
    { path: '/admin/call-routing', testId: 'call-routing-site-select', label: '取次ルート' },
    { path: '/admin/reception-flows', testId: 'reception-flows-site-select', label: '受付フロー' },
    // #554 で移行。版は拠点別なのに既定拠点固定で、UI から別拠点へ到達できなかった。
    {
      path: '/admin/experience-versions',
      testId: 'experience-versions-site-select',
      label: '受付体験の版管理',
    },
  ]) {
    test(`${screen.label}も拠点を切り替えられ、URL に載る`, async ({ page }) => {
      // これらも resolveDefaultScope() に固定されていて、UI から別拠点へ到達できなかった。
      test.skip(
        !!process.env.PLAYWRIGHT_BASE_URL,
        'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
      );

      await page.goto(screen.path);
      const select = page.getByTestId(screen.testId);
      await expect(select).toHaveValue('default-site');

      await select.selectOption('branch-site');
      await expect(page).toHaveURL(/siteId=branch-site/);

      await page.reload();
      await expect(page.getByTestId(screen.testId)).toHaveValue('branch-site');
    });
  }

  test('拠点詳細から辿ると、その拠点のまま設定画面が開く', async ({ page }) => {
    // **これが #421 の「拠点詳細から全関連設定へ到達できる」の実証。**
    // 増分 1〜3 で先に画面側を URL 対応させたので、ここのリンクは実際に拠点を運ぶ。
    // 順序を逆にしていたら、リンクは付いているのに開いた先は既定拠点、になっていた。
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    await page.goto('/admin/sites');
    // 一覧の名称から詳細へ入れる（URL 直打ちでしか開けない画面を作らない）。
    await page.getByTestId('site-detail-link').filter({ hasText: '別館受付' }).click();
    await expect(page.getByTestId('site-detail-id')).toHaveText('branch-site');

    await page.getByTestId('site-dest-devices').click();
    await expect(page).toHaveURL(/\/admin\/devices\?siteId=branch-site/);
    await expect(page.getByTestId('device-site-select')).toHaveValue('branch-site');
  });

  test('拠点を運べない導線には siteId を付けない', async ({ page }) => {
    // 付けても無視される先に付けると、リンクが拠点を運んでいるように見えて実際は捨てられる。
    test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'seed 依存のため実環境では実行しない');

    await page.goto('/admin/sites/branch-site');
    const staff = page.getByTestId('site-dest-staff');
    await expect(staff).toHaveAttribute('href', '/admin/staff');
  });

  test('実在しない siteId は採用せず、実在する拠点へ倒す', async ({ page }) => {
    // ここが安全側の肝。存在しない id をそのまま選択状態にすると、端末一覧が空になり
    // 「この拠点には端末が無い」と**事実と異なる読み方**をされる。
    await page.goto('/admin/devices?siteId=no-such-site');

    await expect(page.getByTestId('device-site-select')).toHaveValue('default-site');
    // 実在拠点へ倒れているので、一覧は「空」ではなく実データが出る。
    await expect(page.getByText('このサイトに登録された受付端末はありません。')).toHaveCount(0);
  });
});

/**
 * 重複ナビの一本化 (#421)。
 *
 * ナビから外した旧画面が**到達不能にならない**ことを実 UI で確かめる。
 * 「ナビから消す」だけだと、受付フローが参照する旧データ（callRouteId）や
 * token 登録フローの編集手段が絶たれる。
 */
test.describe('管理: 重複ナビの一本化 (#421)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('受付端末はナビに 1 つで、旧画面へは devices から辿れる', async ({ page }) => {
    await page.goto('/admin/devices');
    await page.getByTestId('devices-legacy-kiosks-link').click();
    await expect(page).toHaveURL(/\/admin\/kiosks/);
    await expect(page.getByTestId('kiosk-devices-link')).toBeVisible();
  });

  test('旧・呼び出しルートの URL は取次ルートへ redirect する (#873)', async ({ page }) => {
    // 旧画面は**設定しても実通話に効かなかった**ので削除した。ブックマークや手打ちを
    // 404 にせず、正となる画面へ送る。
    await page.goto('/admin/call-routes');
    await expect(page).toHaveURL(/\/admin\/call-routing/);
    await expect(page.getByRole('heading', { level: 1, name: '取次ルート' })).toBeVisible();
  });

  test('redirect は選択中の拠点を落とさない (#873)', async ({ page }) => {
    // **既定拠点だけを見ていると気づけない欠陥。** 旧画面への導線が siteId を落として
    // 別拠点を編集させた前科があり（#421 増分 5 のレビュー P1）、redirect でも同じ形の
    // 取りこぼしが起こりうる。クエリが引き継がれることまで縛る。
    test.skip(!!process.env.PLAYWRIGHT_BASE_URL, 'seed 依存のため実環境では実行しない');

    await page.goto('/admin/call-routes?siteId=branch-site');
    await expect(page).toHaveURL(/\/admin\/call-routing\?siteId=branch-site/);
    await expect(page.getByTestId('call-routing-site-select')).toHaveValue('branch-site');
  });
});

/**
 * ヘッダの対象拠点常設表示 (#423 受入条件「主要画面で現在の tenant/site が常に確認できる」)。
 *
 * **ヘッダと本文がずれないこと**が肝。platform では実際にヘッダ（Cookie の選択）と本文
 * （URL のテナント）が別の対象を示す状態が在った（第 84 wave）。純関数側
 * （`site-context.test.ts`）は本文と同じ解決に委譲することを固定しているが、
 * **クライアント遷移で追従するか**は配線の話なので実ブラウザで見る。
 */
test.describe('管理: ヘッダに対象拠点が常設される (#423)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test('拠点別画面では対象拠点が出る', async ({ page }) => {
    await page.goto('/admin/devices?siteId=default-site');

    const chip = page.getByTestId('active-site');
    await expect(chip).toContainText('本社受付');
    await expect(chip).toHaveAttribute('data-site-id', 'default-site');
    await expect(chip).toHaveAttribute('data-site-source', 'query');
  });

  test('受付体験の版管理でもヘッダに対象拠点が出る (#554)', async ({ page }) => {
    await page.goto('/admin/experience-versions?siteId=default-site');

    const chip = page.getByTestId('active-site');
    await expect(chip).toContainText('本社受付');
    await expect(chip).toHaveAttribute('data-site-source', 'query');
  });

  test('拠点次元を持たない画面では出さない', async ({ page }) => {
    // 部署はテナント全体の設定。ここで「対象拠点: 本社受付」と出すと、拠点別に
    // 分かれているように読める（無い区別を作らない）。
    await page.goto('/admin/departments');

    await expect(page.getByTestId('active-site')).toHaveCount(0);
    // 対象テナントは（拠点と違って）どの画面でも出続ける。ここが 0 になっていたら
    // 「拠点を出さない」ではなくヘッダごと壊している。単一所属は固定表示、複数所属は
    // セレクタになるのでどちらでも良い。
    await expect(
      page.locator('[data-testid="active-tenant"], [data-testid="admin-tenant-switcher"]'),
    ).toHaveCount(1);
  });

  test('拠点詳細では URL の拠点をそのまま出す', async ({ page }) => {
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    await page.goto('/admin/sites/branch-site');

    const chip = page.getByTestId('active-site');
    await expect(chip).toContainText('別館受付');
    await expect(chip).toHaveAttribute('data-site-source', 'route');
  });

  test('実在しない拠点は既定へ倒さず「見つかりません」と出す', async ({ page }) => {
    // **黙って既定拠点へ倒さない。** 倒すと、別拠点の情報を見ているのに気づけない。
    await page.goto('/admin/sites/no-such-site');

    const chip = page.getByTestId('active-site');
    await expect(chip).toHaveAttribute('data-site-state', 'unknown');
    await expect(chip).toContainText('no-such-site');
  });

  test('本文で拠点を切り替えるとヘッダも追従する（リロード無し）', async ({ page }) => {
    test.skip(
      !!process.env.PLAYWRIGHT_BASE_URL,
      'branch-site は seed 由来で、dynamodb backend では seed が無視されるため実環境には存在しない',
    );

    await page.goto('/admin/devices');
    await expect(page.getByTestId('active-site')).toContainText('本社受付');

    await page.getByTestId('device-site-select').selectOption('branch-site');

    // 共有 layout の props はクライアント遷移で更新されない（第 87 wave）。
    // サーバから拠点を渡す実装だと、ここで「本社受付」のまま固まる。
    await expect(page.getByTestId('active-site')).toContainText('別館受付');
  });
});
