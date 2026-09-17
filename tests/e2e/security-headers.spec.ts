import { test, expect } from '@playwright/test';
import { buildCsp } from '@/lib/security/csp';

/**
 * セキュリティヘッダの E2E (issue #6)。
 * 主要レスポンスに CSP・クリックジャッキング対策・nosniff 等が付与されることを確認する。
 */
test('トップのレスポンスにセキュリティヘッダが付与される', async ({ request }) => {
  const res = await request.get('/');
  const headers = res.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('geolocation=()');
  // 🔴 **中身ではなく「配線」を縛る (#1132)。**
  // 配る CSP の**中身**は `src/lib/security/csp.test.ts` が 1 文字ずつ固定している
  // （ZAP 10055 のワイルドカード禁止もそこで自明に満たされる）。ここが縛るのは
  // **その関数が作った文字列がそのまま応答に載っているか**である。
  // 同じ期待文字列を 2 か所に書かない（#1123 で踏んだ「境界を 2 回書く」型）。
  const csp = headers['content-security-policy'];
  expect(csp).toBeTruthy();
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).toBe(buildCsp(nonce!, { frameAncestors: 'none' }));
  // 🔴 **導出されない第 2 の証人（レビュー 6 周目で復活、7 周目で直した）。**
  //
  // 上の行は `buildCsp` に 100% 依存するので、**中身を緩める変更には構造上反応しない**。
  // 元の spec は `not.toContain(' https:')` を持っており、それが e2e 側の唯一の
  // 非導出の証人だった。6 周目にそれを**そのまま**戻したのは誤りで、
  // **この増分がそもそも直そうとした偽陽性を復活させていた** ——
  // `https://static.opentok.com` は ` https:` を部分文字列として含むので、
  // 方式 A の正当な作業で落ちる（レビュー 7 周目の指摘）。
  //
  // 🔴 **token 単位で見る。** 禁じたいのは ZAP 10055 の
  // **ワイルドカード source 式**（`*` / `http:` / `https:`）で、`https://<ホスト>` ではない。
  // ここは意図的に**狭い**（裾 —— `https://*` / `*:*` 等 —— は unit 側の allowlist が見る）。
  // 方式 A で赤くなったときの正しい直し方は**この行を消すことではなく**、
  // 具体ホストが token 一致しないことを確かめて通す（＝何もしない）である。
  expect(wildcardTokens(csp)).toEqual([]);
  // クロスオリジン分離ヘッダ（ZAP 90004 / 堅牢化）。
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
});

/**
 * ZAP 10055 のワイルドカード source 式（`*` / `http:` / `https:`）を token 単位で拾う。
 * `https://<ホスト>` のような具体ホストは**拾わない**（そこは unit 側の allowlist の担当）。
 */
function wildcardTokens(csp: string): string[] {
  const WILDCARD_SOURCES = ['*', 'http:', 'https:'];
  return csp
    .split(';')
    .flatMap((d) => d.trim().split(/\s+/).slice(1))
    .filter((t) => WILDCARD_SOURCES.includes(t.toLowerCase()));
}

/**
 * 🔴 **非導出の証人の下界（レビュー 8 周目 MINOR 1）。**
 *
 * 上の主張は `toEqual([])` なので、`WILDCARD_SOURCES` が空になっても
 * `sources` が空になっても**無言で満たせる**（`expect([]).toEqual([])`）。
 * unit 側の `unboundedSources` には 27 行の負の対照が在るのに、
 * e2e 側の同型の機構には 1 つも無かった。ブラウザ不要なのでここで縛る。
 */
test('🔴 ワイルドカード検査そのものが効いている（下界・ブラウザ不要）', () => {
  expect(wildcardTokens("script-src 'self' *")).toEqual(['*']);
  expect(wildcardTokens("connect-src 'self' https:")).toEqual(['https:']);
  expect(wildcardTokens("connect-src 'self' HTTP:")).toEqual(['HTTP:']);
  // 具体ホストは拾わない（この増分が直した偽陽性の回帰）。
  expect(wildcardTokens("script-src 'self' https://static.opentok.com")).toEqual([]);
});

test('script-src は nonce 化され unsafe-inline を含まない (#200)', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'];
  // 🔴 完全名で引く（`script-src-elem` は別ディレクティブで、`script-src` を上書きする）。
  const scriptSrc = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === 'script-src' || d.startsWith('script-src '));
  expect(scriptSrc).toBeTruthy();
  expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
  expect(scriptSrc).not.toContain("'unsafe-inline'");
});

test('style-src は unsafe-inline を含まず、style 属性は style-src-attr で許可する (#289)', async ({ request }) => {
  const res = await request.get('/');
  const directives = res
    .headers()
    ['content-security-policy'].split(';')
    .map((d) => d.trim());
  const styleSrc = directives.find((d) => d.startsWith('style-src '));
  const styleSrcAttr = directives.find((d) => d.startsWith('style-src-attr'));
  // 本番ビルド（e2e 対象）では style-src（elem フォールバック）は 'self' のみ。
  expect(styleSrc).toBe("style-src 'self'");
  // React SSR の style 属性は style-src-attr で明示許可する（nonce 不可のため）。
  expect(styleSrcAttr).toBe("style-src-attr 'unsafe-inline'");
});

test('inline <style> なしでスタイルが適用される（CSP violation なし / #289）', async ({ page }) => {
  // 注: /kiosk は #239 のセッションゲートで enroll なしだと受付画面にならないため、
  // 素の fixture で検証できるランディングを対象にする（kiosk 画面の CSP 影響は
  // kiosk-* suite の表示/スクリーンショット検証が担保する）。
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Content Security Policy')) violations.push(msg.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('lp-login')).toBeVisible();
  // 外部 stylesheet（globals.css）が実際に適用されている（ブロックされていない）こと。
  const bodyMargin = await page.evaluate(() => getComputedStyle(document.body).margin);
  expect(bodyMargin).toBe('0px');
  expect(violations).toEqual([]);
});

/**
 * 🔴 **現状を固定する（#1132）。閉じたら赤くなるのが正しい。**
 *
 * 上の「CSP violation なし」の対象は **`/` の 1 ページだけ**で、通話画面は誰も見ていなかった。
 * その通話画面では、`src/adapters/call/vonage-client.ts` が CDN から読む Vonage SDK を
 * **CSP が拒否している** —— つまり**映像通話はブラウザで原理的に成立しない**（来訪者側の
 * `KioskCallView` も同じアダプタを使う）。
 *
 * この test は「直っていること」ではなく「**まだ直っていないこと**」を固定する。
 * `src/lib/auth/broken-deploy-reachability.test.ts` と同じ契約で、
 * **#1132 増分 2 が CSP を開いたらこの test が赤くなる**（そのとき反転させる）。
 * 散文の「まだ塞いでいない」を実行可能な形にしたもの。
 *
 * 🔴 **既存の e2e はこの欠陥を構造的に踏めない。** `kiosk-calling-stage.spec.ts` は
 * `page.addInitScript` で `window.OT` を偽物に置くので、`defaultLoadSdk` の
 * 「グローバルが既にあれば即返す」分岐に乗り、**`<script src>` を一度も発行しない**。
 */
test('🔴 通話画面では Vonage SDK が CSP に拒否される（#1132 が閉じたら赤くなる）', async ({
  page,
  browserName,
}) => {
  // 🔴 **コンソール文言はエンジン固有（レビュー 7 周目）。** CSP 違反のメッセージ形式は
  // WebKit と Chromium で違う。エンジン非依存の 2 本（`typeof OT` / `script[data-vonage-sdk]`）
  // は無条件に残し、**コンソール系の 2 本だけ** chromium に限定する。
  // 今日のゲートは webkit project を走らせない（`CI` / `E2E_WEBKIT` を設定しない）が、
  // #65 の実機検証は iPad Safari を通るので、そこで**テスト自身が誤読を誘発しない**ようにする。
  const consoleAssertable = browserName === 'chromium';
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Content Security Policy')) violations.push(msg.text());
  });
  await page.route('**/api/staff/calls/*/answer', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // 固定日付を書かない（#833 の time bomb）。
      body: JSON.stringify({
        applicationId: 'TEST-application',
        sessionId: 'TEST-session',
        token: 'TEST-subscriber-token',
        role: 'subscriber',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }),
    });
  });
  await page.goto('/staff/calls/rec-1?token=some-token');
  // 🔴 **違反そのものを待たない。** 待つと「違反が来るまで待つ」＝主張と同義になる。
  // 画面が失敗状態へ落ち着いたことを独立したアンカーにする（文言に依らない属性で取る）。
  await expect(page.locator('[data-call-state="error"]')).toBeVisible();

  // 🔴 **下界（試みたこと）。** 「`OT` が無い」は、アダプタが**読みに行かなくなった**
  // 世界でも満たせる。`<script>` が実際に挿さっていることを併せて縛る。
  await expect(page.locator('script[data-vonage-sdk]')).toHaveCount(1);

  // 🔴 **本体は「成果」で書く。壁は 1 つではない。**
  // 実測では `script-src` を開いても COEP `require-corp` が `crossorigin` 無しの
  // cross-origin script を止める（レビュー 1 周目）。CSP のコンソール文字列を主語にすると
  // **壁 1 が消えた瞬間に「閉じた」と読める**形で赤くなり、通話が壊れたまま緑へ
  // 反転させられてしまう（大声の失敗を沈黙の誤動作へ変える型）。
  expect(await page.evaluate(() => typeof (window as { OT?: unknown }).OT)).toBe('undefined');

  // 補助: **今日の壁が CSP であること**を記録する（主語ではない）。
  // 増分 2 で壁 1 だけ外したときは、ここだけが落ちて本体は落ちない —— それが正しい。
  // 🔴 **env から持ってこない（レビュー 3 周目）。** `NEXT_PUBLIC_VONAGE_SDK_URL` は
  // **ビルド時に**クライアントへ inline されるので、テストプロセスの env とずれると
  // 「壁 1 は開いた」と読める嘘の赤になる。**このビルドが実際に読みに行った先**を DOM から取る。
  const sdkSrc = await page.locator('script[data-vonage-sdk]').getAttribute('src');
  const sdkHost = new URL(sdkSrc!, page.url()).host;
  if (!consoleAssertable) return;
  // 🔴 **落ち方が次の一手を指すようにする。** ここだけが落ちたら「壁 1（CSP）は開いた」
  // という意味で、**この行を消して緑に戻すのは誤り**（通話は壊れたままになる）。
  expect(
    violations.join('\n'),
    '壁 1（script-src）は開いた。次は COEP と crossOrigin、さらに connect-src と style-src を見る（docs/vonage-call-design.md §10-A）。この assertion を消して緑に戻さないこと',
  ).toContain(sdkHost);

  // 🔴 **主語を「成果」へ移したときに、この下界を落としかけた。**
  // 「止まっているのが SDK だけ」は COEP のような CSP 以外の壁を観測できないが、
  // **この画面で CSP を別の形で壊したら赤くなる**という別の保証を持っている。
  // 主語の差し替えは正しかったが、**前の方式が守っていた変異まで捨てない**
  // （`.claude/rules/opus5-autonomous-loop.md`「方式を替えたら当て直す」）。
  expect(violations.filter((v) => !v.includes(sdkHost))).toEqual([]);
});

test('nonce はレスポンスごとに変わる (#200)', async ({ request }) => {
  const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1];
  const [a, b] = await Promise.all([request.get('/'), request.get('/')]);
  const nonceA = nonceOf(a.headers()['content-security-policy']);
  const nonceB = nonceOf(b.headers()['content-security-policy']);
  expect(nonceA).toBeTruthy();
  expect(nonceA).not.toBe(nonceB);
});

test('未認証の /admin リダイレクト(307)も Content-Type を返す', async ({ request }) => {
  // ZAP 10019: Content-Type 欠落の解消。リダイレクト本体は追わずに 307 応答そのものを検査する。
  const res = await request.get('/admin', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['content-type']).toContain('text/plain');
});

test('kiosk と admin もセキュリティヘッダを返す', async ({ request }) => {
  for (const path of ['/kiosk', '/admin/login']) {
    const res = await request.get(path);
    const csp = res.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(res.headers()['x-frame-options']).toBe('DENY');
    // 🔴 **中身まで見る（レビュー 15 周目 MINOR 4）。** 以前はここが `toBeTruthy()` だけで、
    //    CSP の中身を実ビルドで見ているのは `/` の 1 経路しか無かった。
    //    unit の全ルート固定（I4）と重複して見えるが、**unit は `NODE_ENV=test` の世界でしか
    //    測れない** —— 本番ビルドで配られる値を見るのはここだけなので重複ではない。
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce, `nonce missing for ${path}`).toBeTruthy();
    expect(csp, `${path} の CSP が buildCsp の出力と違う`).toBe(buildCsp(nonce!, { frameAncestors: 'none' }));
    expect(wildcardTokens(csp)).toEqual([]);
  }
});
