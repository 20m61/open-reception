import { test, expect, type Browser, type Page } from "@playwright/test";
import { establishKioskSession, loginAsAdmin } from "./helpers";

/**
 * **グローバルなセキュリティ設定（PIN の値・pinRequired・緊急停止）を実際に書き換える** E2E
 * (issue #23 / #244 / #1021 を `kiosk-access.spec.ts` から切り出した, #1161)。
 *
 * 🔴 **専用の終端 project `security-settings-mutation` で単独に走る。** 同居者は 0。
 *
 * - `test.describe.configure({ mode: "serial" })` は**このファイルの中**の順序を縛るだけで、
 *   同じ project の**別ファイル**との並行は止まらない（`fullyParallel` は config 全体に効く）。
 *   以前は既定 project `chromium-ipad` に居たので、PIN で authorize する spec が 1 本でも
 *   足された瞬間にそれが flaky になり、`retries` が吸収して緑のまま見えなくなる —— #787 と同じ型。
 * - 設定の保存は版付き (#1158)。ここで版が進むと、並行して `rev` を読んでいた別の書き手が
 *   409 になる。**緊急停止のトグルも版を進める**ので、書き込む側は全部ここへ集める。
 * - 🔴 **`flow-mutation-kiosk` へ相乗りさせない**（playwright.config.ts の
 *   STAFF_AVAILABILITY_MUTATING_SPECS の注記、#787）。
 *
 * 読むだけのテスト（未エンロール案内・pinRequired=false での 403 など）は既定 project の
 * `kiosk-access.spec.ts` に残る。このファイルは既定 project が全部終わった後に走るので、
 * 読む側が書き換え途中の値を観測することもない。
 */
test.describe.configure({ mode: "serial" });

/**
 * 管理画面と同じく、GET で読んだ版（`rev`）を付けて設定を保存する (#1158)。
 * 版なしで受け付けるのは緊急停止のトグルだけで、それ以外は 428 になる。
 */
async function putSecurity(page: Page, data: Record<string, unknown>) {
  const current = (await (await page.request.get("/api/admin/security")).json()) as { rev: number };
  return page.request.put("/api/admin/security", { data: { rev: current.rev, ...data } });
}

/**
 * 🔴 **後始末は `test.afterEach`（`finally` ではない）、そして応答を見る (#1161 AC3)。**
 *
 * `.claude/rules/opus5-autonomous-loop.md` の実測: timeout でページが閉じられると
 * `finally` の中の `await` は**即 reject し、復元されないまま run の残り全部が汚染される**。
 * 応答を見ないと復元の失敗が**沈黙**する。
 *
 * - テスト本体がどこで止まっても復元できるよう、**ここで改めて admin にログインする**
 *   （Playwright は test ごとに新しい context なので、本体のログインに頼ると
 *   ログイン前に落ちた回で 401 になり、復元経路が検証されない）。
 * - 🔴 **完全には元に戻らない**（#1021 レビュー 3 周目 MINOR 8）。`pinSetByOperator` を
 *   false へ戻す API 経路が無いため、既定値 `0000` を入れ直すことで
 *   「運用者が決めていない」状態へは戻る（＝`pinConfigured` は false に戻る）。
 */
test.afterEach(async ({ page }) => {
  await loginAsAdmin(page);
  const res = await putSecurity(page, { pin: "0000", pinRequired: false });
  expect(
    res.ok(),
    `PIN / pinRequired の復元に失敗した（以降の spec が汚染される）: ${res.status()}`,
  ).toBeTruthy();
});

test("pinRequired=true では正しい PIN の authorize がセッションを発行する（実 cookie 往復, #23/#244）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  // グローバル設定を一時的に PIN 必須へ（戻すのは afterEach）。
  const put = await putSecurity(page, { pinRequired: true });
  expect(put.ok()).toBeTruthy();
  // 🔴 **登録していない端末は正しい PIN でも通らない (#1237)。** body の kioskId は根拠にしない。
  const unenrolled = await page.request.post("/api/kiosk/authorize", {
    data: { pin: "0000", kioskId: "kiosk-dev" },
  });
  expect(unenrolled.status()).toBe(403);
  const before = await page.request.get("/api/kiosk/session-status");
  expect(((await before.json()) as { authorized: boolean }).authorized).toBe(false);

  // 登録済みの端末は既定 PIN 0000 で許可 → Set-Cookie（下界。上の 403 を「全部拒否」で満たさせない）。
  await establishKioskSession(page);
  const auth = await page.request.post("/api/kiosk/authorize", {
    data: { pin: "0000" },
  });
  expect(auth.ok()).toBeTruthy();
  // session-status はエンロール時点で true なので見ない（空虚に通る）。発行そのものを見る。
  expect(auth.headers()["set-cookie"] ?? "").toContain("kiosk_session=");
});

/**
 * 🔴 **管理画面で決めた PIN が、端末の authorize まで通しで効く (#1021 AC3)。**
 *
 * unit は「ストアへ保存 → 照合」までしか見ていない。**PIN がハッシュで保存されるように
 * なった**ので、管理 API（PUT）と端末 API（POST authorize）が**同じ解釈**を持っている
 * ことを HTTP 越しに確かめる —— 片方だけが旧形式を知っている状態は、
 * `pinRequired: true` のサイトを**丸ごと締め出す**形で表面化する。
 *
 * 🔴 **グローバルな PIN の値そのもの**を書き換える（#1161 の直接の対象）。後始末は上の afterEach。
 */
/**
 * 🔴 **未登録の端末の PIN 画面は、登録し直す案内を出す（#1237 journey B）。**
 *
 * PIN 認可は登録済みの端末に限られた。未登録の端末が PIN 画面で**正しい PIN**を入れても
 * 403 `not_enrolled` になる。そのとき「PIN が正しくありません」と出すと、PIN を疑って
 * 打ち直し続けるだけで、登録が要るという本当の原因へ辿り着けない。
 *
 * - 画面は**別の context**（admin cookie も kiosk セッションも持たない端末）で開く。
 * - 判定は `data-failure`（文言の書き写しではない）と、「PIN を疑わせない」の否定。
 * - 下界: 送った PIN は**正しい既定 PIN**。誤った PIN で測ると、`wrong_pin` を出す実装との
 *   区別が「PIN が違うから」に飲み込まれる。
 */
test("🔴 未登録の端末は正しい PIN でも PIN 画面に再登録の案内が出る（#1237 journey B）", async ({
  page,
  browser,
}) => {
  await loginAsAdmin(page);
  const put = await putSecurity(page, { pinRequired: true });
  expect(put.ok()).toBeTruthy();

  // 🔴 後始末に finally を使わない（このファイルの規約。設定の復元は afterEach が持つ）。
  //    context は閉じ損ねても worker の終了で破棄され、グローバル設定には触れない。
  const kiosk = await browser.newContext();
  const kp = await kiosk.newPage();
  await kp.goto("/kiosk");
  // pinRequired=true の未認可端末は PIN 画面（journey B: PIN 画面は残す）。
  const pin = kp.getByTestId("kiosk-pin");
  await expect(pin).toBeVisible({ timeout: 15_000 });
  await pin.fill("0000");
  const authorized = kp.waitForResponse((r) => r.url().endsWith("/api/kiosk/authorize"));
  await kp.getByTestId("kiosk-authorize").click();
  const res = await authorized;
  // サーバ側の前提（ここが崩れたら下の画面の主張は別の原因を見ている）。
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe("not_enrolled");

  const error = kp.getByTestId("kiosk-pin-error");
  await expect(error).toHaveAttribute("data-failure", "not_enrolled");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).not.toContainText("PIN が正しくありません");
  await expect(error).toContainText("QR");
  // 受付フローへは入らない（PIN 画面のまま）。
  await expect(kp.getByTestId("start-reception")).toHaveCount(0);
  await kiosk.close();
});

/**
 * 🔴 **セッションが切れた登録済みの端末は、PIN 画面から再認可できる（#1237 端末証明）。**
 *
 * PIN 画面が出るのは有効なセッションが無いときである。セッションだけを登録の根拠にすると、
 * PIN 画面からの PIN は**常に** `not_enrolled` になる（#1263 のレビュー）。エンロールで発行する
 * 端末証明（`kiosk_device`、HttpOnly・authorize 限定 path）が、セッションと別に登録を示す。
 *
 * - セッション切れは `kiosk_session` cookie だけを消して再現する（証明は残る）。
 * - 端末は**別の context**（admin cookie を持たない）。管理操作は `page` 側で行う。
 * - 後始末: 設定の復元は afterEach。context は閉じ損ねても worker 終了で破棄される。
 */
test.describe("端末証明による PIN 再認可 (#1237)", () => {
  async function enrolledKioskWithoutSession(browser: Browser) {
    const kiosk = await browser.newContext();
    const kp = await kiosk.newPage();
    const deviceId = await establishKioskSession(kp);
    const credential = (await kiosk.cookies()).find((c) => c.name === "kiosk_device");
    // 証明の形（ここが崩れたら下の主張は別の原因を見ている）。
    expect(credential, "エンロールが端末証明を設定していない").toBeDefined();
    expect(credential?.httpOnly).toBe(true);
    expect(credential?.path).toBe("/api/kiosk/authorize");
    await kiosk.clearCookies({ name: "kiosk_session" });
    return { kiosk, kp, deviceId, credential: credential! };
  }

  async function submitPin(kp: Page, value: string) {
    await kp.goto("/kiosk");
    const pin = kp.getByTestId("kiosk-pin");
    await expect(pin).toBeVisible({ timeout: 15_000 });
    await pin.fill(value);
    const responded = kp.waitForResponse((r) => r.url().endsWith("/api/kiosk/authorize"));
    await kp.getByTestId("kiosk-authorize").click();
    return responded;
  }

  test("🔴 セッション切れの登録済み端末は、PIN 画面の正しい PIN で受付に戻る（誤った PIN は 401）", async ({
    page,
    browser,
  }) => {
    await loginAsAdmin(page);
    expect((await putSecurity(page, { pinRequired: true })).ok()).toBeTruthy();
    const { kiosk, kp } = await enrolledKioskWithoutSession(browser);

    // 誤った PIN は登録済みでも 401（登録は PIN を代替しない）。
    const wrong = await submitPin(kp, "9999");
    expect(wrong.status()).toBe(401);
    await expect(kp.getByTestId("kiosk-pin-error")).toHaveAttribute("data-failure", "wrong_pin");

    const res = await submitPin(kp, "0000");
    expect(res.status()).toBe(200);
    // ブラウザ側の応答は Set-Cookie を見せないので、発行は cookie ジャーで確かめる。
    expect((await kiosk.cookies()).some((c) => c.name === "kiosk_session")).toBe(true);
    // PIN 画面を抜けて受付の待機画面へ。
    await expect(kp.getByTestId("kiosk-pin")).toHaveCount(0, { timeout: 15_000 });
    await expect(kp.getByTestId("start-reception").first()).toBeVisible({ timeout: 15_000 });
    await kiosk.close();
  });

  test("🔴 失効した端末は、証明を持っていても PIN 画面で再登録の案内になる", async ({
    page,
    browser,
  }) => {
    await loginAsAdmin(page);
    expect((await putSecurity(page, { pinRequired: true })).ok()).toBeTruthy();
    const { kiosk, kp, deviceId } = await enrolledKioskWithoutSession(browser);
    const revoked = await page.request.patch(`/api/admin/devices/${deviceId}`, {
      data: { tenantId: "internal", enabled: false },
    });
    expect(revoked.ok()).toBeTruthy();

    const res = await submitPin(kp, "0000");
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_enrolled");
    await expect(kp.getByTestId("kiosk-pin-error")).toHaveAttribute("data-failure", "not_enrolled");
    await kiosk.close();
  });

  test("🔴 再登録の前に発行された古い証明では再認可できない（新しい証明では通る）", async ({
    page,
    browser,
  }) => {
    await loginAsAdmin(page);
    expect((await putSecurity(page, { pinRequired: true })).ok()).toBeTruthy();
    const { kiosk, kp, deviceId, credential: old } = await enrolledKioskWithoutSession(browser);

    // 同じ端末を登録し直す（世代が上がる）。
    const issued = await page.request.post(`/api/admin/devices/${deviceId}/reissue-token`, {
      data: { tenantId: "internal" },
    });
    expect(issued.ok()).toBeTruthy();
    const { enrollmentUrl } = (await issued.json()) as { enrollmentUrl: string };
    const token = new URL(enrollmentUrl).searchParams.get("token") ?? "";
    expect((await kp.request.post("/api/kiosk/enroll", { data: { token } })).ok()).toBeTruthy();
    const fresh = (await kiosk.cookies()).find((c) => c.name === "kiosk_device");
    expect(fresh?.value).not.toBe(old.value);

    // 古い証明に差し替え、セッションを消す。
    await kiosk.clearCookies({ name: "kiosk_session" });
    await kiosk.addCookies([old]);
    const stale = await submitPin(kp, "0000");
    expect(stale.status()).toBe(403);
    expect(((await stale.json()) as { error: string }).error).toBe("not_enrolled");

    // 下界: 新しい証明なら通る（上の 403 を「全部拒否」で満たさせない）。
    await kiosk.addCookies([fresh!]);
    expect((await submitPin(kp, "0000")).status()).toBe(200);
    await kiosk.close();
  });
});

test.describe("管理画面で決めた PIN (#1021)", () => {
  test("🔴 管理画面で決めた PIN で authorize できる（ハッシュ保存の通し確認, #1021）", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const res = await putSecurity(page, { pinRequired: true, pin: "4821" });
    expect(res.ok()).toBeTruthy();
    // 🔴 応答に PIN の値（平文もハッシュも）が出ていないこと。
    const put = await res.text();
    expect(put).not.toContain("4821");
    expect(put).not.toContain("pbkdf2");
    expect(JSON.parse(put)).toMatchObject({ pinConfigured: true });
    // 決めた PIN では通る（後始末は afterEach が持つ）。PIN 認可は登録済みの端末に限る (#1237)。
    await establishKioskSession(page);
    const ok = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "4821" },
    });
    expect(ok.ok()).toBeTruthy();
    // 🔴 session-status は見ない —— エンロールで cookie は既にあるので、authorize が何も
    //    発行しなくても authorized=true になり空虚に通る。発行そのものを見る。
    expect(ok.headers()["set-cookie"] ?? "").toContain("kiosk_session=");
  });

  /**
   * 🔴 **下界: 決めた PIN 以外は通らない（上のテストが「何でも通る」世界でも満たせないように）。**
   */
  test("🔴 管理画面で決めた PIN と違う入力は authorize できない（#1021）", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const put = await putSecurity(page, { pinRequired: true, pin: "4821" });
    expect(put.ok()).toBeTruthy();
    // 登録済みの端末で測る (#1237)。未登録だと PIN を見る前に 403 になり、下の拒否が何も言わない。
    await establishKioskSession(page);
    const ng = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "0000" },
    });
    expect(ng.ok()).toBeFalsy();
    // 🔴 PIN を送らない要求も通らない（レビュー 1 周目 BLOCKER の通し確認）。
    const empty = await page.request.post("/api/kiosk/authorize", {
      data: {},
    });
    expect(empty.ok()).toBeFalsy();
    // 🔴 **下界 (#1021 AC4)。** 失敗した直後でも、**予算内なら正しい PIN で通る**。
    //    上の 2 本だけだと「全部拒否」でも満たせてしまう —— AC4 の試行回数制限が
    //    正当な来訪者を閉め出していないことを HTTP 越しに固定する。
    //
    // 🔴 **副作用として共有状態を戻している。** 予算の鍵は**サイト全体**なので、
    //    失敗を残したまま抜けると**後続の authorize が 429 になりうる**
    //    （成功は失敗数を捨てるので、ここで戻る）。#1161 と同じ「同居者との共有状態」の型。
    const recovered = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "4821" },
    });
    expect(
      recovered.ok(),
      "失敗の直後に正しい PIN が通らない（AC4 が正当な来訪者を閉め出している）",
    ).toBeTruthy();
  });
});

test("管理者はセキュリティ設定を取得・更新できる（PIN は無効化したまま）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const get = await page.request.get("/api/admin/security");
  expect(get.ok()).toBeTruthy();

  const put = await putSecurity(page, { pinRequired: false, ipAllowlist: [] });
  const body = (await put.json()) as { pinRequired: boolean };
  expect(body.pinRequired).toBe(false);
});

test("緊急停止 API は emergencyStop を返す（false のまま）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const res = await page.request.put("/api/admin/security", {
    data: { emergencyStop: false },
  });
  const body = (await res.json()) as { emergencyStop: boolean };
  expect(body.emergencyStop).toBe(false);
});
