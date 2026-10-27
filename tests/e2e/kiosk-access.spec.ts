import { test, expect } from "@playwright/test";
import { establishKioskSession, loginAsAdmin } from "./helpers";

/**
 * 受付端末アクセス制御の E2E (issue #23 / #239 / #244)。
 *
 * 🔴 **このファイルはグローバルなセキュリティ設定を書き換えない**（既定 project `chromium-ipad` で
 * 他 spec と並行に走るため）。PIN の値・pinRequired・緊急停止を実際に書き換えるテストは
 * `kiosk-security-mutation.spec.ts`（専用の終端 project `security-settings-mutation`）へ
 * 切り出した (#1161)。`test.describe.configure({ mode: "serial" })` では同じ project の
 * **別ファイル**との並行は止まらないので、書き換える側は同居者 0 の project に置くしかない。
 * ここに残るテストは読むだけ（pinRequired は既定 false のまま観測する）。
 */
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
