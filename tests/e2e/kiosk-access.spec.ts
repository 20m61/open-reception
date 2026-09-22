import { test, expect } from "@playwright/test";
import { establishKioskSession, loginAsAdmin } from "./helpers";

/**
 * 受付端末アクセス制御の E2E (issue #23 / #239 / #244)。
 *
 * pinRequired はグローバル設定で、切り替えると他テストの /kiosk ゲート判定に干渉する。本ファイルは
 * 一部テストが pinRequired を一時的に true にするため **serial 実行**にして相互干渉を防ぐ（true にした
 * テストは必ず finally で false へ戻す）。他ファイルの kiosk spec はセッション保持のため影響しない。
 */
test.describe.configure({ mode: "serial" });

test("kiosk セッション未保持で /kiosk は未エンロール案内を出す（受付フローを出さない, #239）", async ({
  page,
}) => {
  // セッション未確立のまま /kiosk へ直接到達（pinRequired は既定 false）。
  await page.goto("/kiosk");
  // 受付フローではなく未エンロール案内が出る（heartbeat 後にゲートが閉じる）。
  await expect(page.getByTestId("kiosk-unenrolled")).toBeVisible({
    timeout: 15_000,
  });
  // 受付待機画面の開始導線は出ない（フローへ入れない）。
  await expect(page.getByTestId("start-reception")).toHaveCount(0);
});

test("pinRequired=false では authorize がセッションを発行しない（403, #244）", async ({
  page,
}) => {
  // PIN 不要運用では PIN 自己許可を認めない（誰でも authorize でゲートを回避できないように）。
  const auth = await page.request.post("/api/kiosk/authorize", {
    data: { pin: "0000", kioskId: "kiosk-dev" },
  });
  expect(auth.status()).toBe(403);

  const status = await page.request.get("/api/kiosk/session-status");
  const body = (await status.json()) as { authorized: boolean };
  expect(body.authorized).toBe(false);
});

test("pinRequired=true では正しい PIN の authorize がセッションを発行する（実 cookie 往復, #23/#244）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  // グローバル設定を一時的に PIN 必須へ。serial + finally で必ず false へ戻す。
  await page.request.put("/api/admin/security", {
    data: { pinRequired: true },
  });
  try {
    // 既定 PIN 0000 で許可 → Set-Cookie。session-status が同 cookie を読み authorized=true を返す
    // （authorize→cookie→再リクエストの実 HTTP 往復を検証）。
    const auth = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "0000", kioskId: "kiosk-dev" },
    });
    expect(auth.ok()).toBeTruthy();

    const status = await page.request.get("/api/kiosk/session-status");
    const body = (await status.json()) as { authorized: boolean };
    expect(body.authorized).toBe(true);
  } finally {
    await page.request.put("/api/admin/security", {
      data: { pinRequired: false },
    });
  }
});

/**
 * 🔴 **管理画面で決めた PIN が、端末の authorize まで通しで効く (#1021 AC3)。**
 *
 * unit は「ストアへ保存 → 照合」までしか見ていない。**PIN がハッシュで保存されるように
 * なった**ので、管理 API（PUT）と端末 API（POST authorize）が**同じ解釈**を持っている
 * ことを HTTP 越しに確かめる —— 片方だけが旧形式を知っている状態は、
 * `pinRequired: true` のサイトを**丸ごと締め出す**形で表面化する。
 *
 * 🔴 **共有 seed を書き換えるので、必ず後始末する**（後始末の置き場所は下を参照）。
 */
/**
 * 🔴 **PIN を書き換える spec の後始末は `test.afterEach`（`finally` ではない）。**
 *
 * `.claude/rules/opus5-autonomous-loop.md` の実測: timeout でページが閉じられると
 * `finally` の中の `await` は**即 reject し、復元されないまま run の残り全部が汚染される**。
 * 新規の 2 本は**グローバルな PIN の値そのもの**を書き換えるので、既存 1 本より窓が広い。
 *
 * 🔴 **完全には元に戻らない**（レビュー 3 周目 MINOR 8）。`pinSetByOperator` を
 * false へ戻す API 経路が無いため、既定値 `0000` を入れ直すことで
 * 「運用者が決めていない」状態へは戻る（＝`pinConfigured` は false に戻る）。
 */
test.describe("管理画面で決めた PIN (#1021)", () => {
  // 🔴 **後始末の対象を `describe` で限定する（レビュー 4 周目 MINOR 5）。**
  //    `test.afterEach` は**ファイル全体**に効くので、以前はこの上の
  //    `loginAsAdmin` していない 2 本の後にも走り、**admin セッションが無いので 401**
  //    していた（Playwright は test ごとに新しい context なので cookie は持ち越さない）。
  //    復元すべき状態が無い回だったため実害はゼロだったが、**復元経路が一度も
  //    検証されていない**状態になっていた。
  // 🔴 **応答を見る。** 見ないと復元の失敗が**沈黙**し、run の残り全部が汚染される。
  test.afterEach(async ({ page }) => {
    const res = await page.request.put("/api/admin/security", {
      data: { pin: "0000", pinRequired: false },
    });
    expect(
      res.ok(),
      "PIN の復元に失敗した（以降の spec が汚染される）",
    ).toBeTruthy();
  });

  test("🔴 管理画面で決めた PIN で authorize できる（ハッシュ保存の通し確認, #1021）", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const res = await page.request.put("/api/admin/security", {
      data: { pinRequired: true, pin: "4821" },
    });
    expect(res.ok()).toBeTruthy();
    // 🔴 応答に PIN の値（平文もハッシュも）が出ていないこと。
    const put = await res.text();
    expect(put).not.toContain("4821");
    expect(put).not.toContain("pbkdf2");
    expect(JSON.parse(put)).toMatchObject({ pinConfigured: true });
    // 決めた PIN では通る（後始末は afterEach が持つ）。
    const ok = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "4821", kioskId: "kiosk-dev" },
    });
    expect(ok.ok()).toBeTruthy();
    const status = await page.request.get("/api/kiosk/session-status");
    expect(((await status.json()) as { authorized: boolean }).authorized).toBe(
      true,
    );
  });

  /**
   * 🔴 **下界: 決めた PIN 以外は通らない（上のテストが「何でも通る」世界でも満たせないように）。**
   */
  test("🔴 管理画面で決めた PIN と違う入力は authorize できない（#1021）", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.request.put("/api/admin/security", {
      data: { pinRequired: true, pin: "4821" },
    });
    const ng = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "0000", kioskId: "kiosk-dev" },
    });
    expect(ng.ok()).toBeFalsy();
    // 🔴 PIN を送らない要求も通らない（レビュー 1 周目 BLOCKER の通し確認）。
    const empty = await page.request.post("/api/kiosk/authorize", {
      data: { kioskId: "kiosk-dev" },
    });
    expect(empty.ok()).toBeFalsy();
    // 🔴 **下界 (#1021 AC4)。** 失敗した直後でも、**予算内なら正しい PIN で通る**。
    //    上の 2 本だけだと「全部拒否」でも満たせてしまう —— AC4 の試行回数制限が
    //    正当な来訪者を閉め出していないことを HTTP 越しに固定する。
    //
    // 🔴 **副作用として共有状態を戻している。** 予算の鍵は**サイト全体**なので、
    //    失敗を残したまま抜けると**他の spec の authorize が 429 になりうる**
    //    （成功は失敗数を捨てるので、ここで戻る）。#1161 と同じ「同居者との共有状態」の型。
    const recovered = await page.request.post("/api/kiosk/authorize", {
      data: { pin: "4821", kioskId: "kiosk-dev" },
    });
    expect(
      recovered.ok(),
      "失敗の直後に正しい PIN が通らない（AC4 が正当な来訪者を閉め出している）",
    ).toBeTruthy();
  });
});

test("kiosk セッション（エンロール由来）では管理 API を操作できない", async ({
  page,
}) => {
  await establishKioskSession(page);
  // kiosk_session は持つが admin_session は持たない → 401。
  const res = await page.request.get("/api/admin/security");
  expect(res.status()).toBe(401);
});

test("セキュリティ設定は未認証だと 401", async ({ page }) => {
  const res = await page.request.get("/api/admin/security");
  expect(res.status()).toBe(401);
});

test("管理者はセキュリティ設定を取得・更新できる（PIN は無効化したまま）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const get = await page.request.get("/api/admin/security");
  expect(get.ok()).toBeTruthy();

  const put = await page.request.put("/api/admin/security", {
    data: { pinRequired: false, ipAllowlist: [] },
  });
  const body = (await put.json()) as { pinRequired: boolean };
  expect(body.pinRequired).toBe(false);
});

test("セキュリティ設定ページが表示される", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto("/admin/security");
  await expect(page.getByTestId("security-pin-required")).toBeVisible();
  await expect(page.getByTestId("emergency-section")).toBeVisible();
});

test("緊急停止は確認ステップを挟む（実行はしない＝他テストを止めない）", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.goto("/admin/security");
  await page.getByTestId("emergency-stop").click();
  // 確認ボタンが出るが、停止せず「やめる」で取り消す（グローバル状態は変えない）。
  await expect(page.getByTestId("emergency-confirm")).toBeVisible();
  await page.getByTestId("emergency-cancel").click();
  await expect(page.getByTestId("emergency-stop")).toBeVisible();
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
