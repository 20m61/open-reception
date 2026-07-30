import { test as base, expect, type Page } from '@playwright/test';
import { establishKioskSession } from './helpers';

/**
 * kiosk セッションを自動確立する test フィクスチャ (issue #239 / #244)。
 *
 * `/kiosk` は kiosk セッション必須になった（未保持なら受付フローを出さず「未エンロール」誘導）。
 * `/kiosk` を直接 goto して受付フローを検証する spec は、`@playwright/test` ではなくこのファイルから
 * `test` を import することで、各テストの最初にセッション cookie を確立する
 * （`page.request` は BrowserContext と cookie を共有するため以降の goto も認証済みになる）。
 *
 * 確立は **エンロール経由** (issue #244)。`pinRequired=false`（e2e 既定）では PIN 自己許可 API が
 * 無効化されたため、`helpers.establishKioskSession` が管理発行トークンを消費して session を得る。
 * 未エンロール/未認証状態を検証する spec はこれを使わず `@playwright/test` の素の `test` を使うこと。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await establishKioskSession(page);
    await use(page);
  },
});

/**
 * QR 受付の**状態機械が実際にどこに居るか**を表明する (#361 調査)。
 *
 * 画面固有の testid（`checkin-scanning` 等）だけを見ると、失敗が
 * `element(s) not found` としか出ず**どの状態に居たのかが分からない**。実際
 * `kiosk-checkin-subtitle-i18n.spec.ts:47` が 2 セッション連続で flaky になった際、
 * ログから分かるのは「5 秒間 `checkin-scanning` が無かった」ことだけで、
 * cameraError へ落ちたのか、そもそも遷移していないのか、待機へ戻ったのかが区別できなかった。
 *
 * `checkin-shell` の `data-checkin-state` を先に突き合わせると、失敗時に
 * `Expected: "scanning" / Received: "cameraError"` のように**実際の状態が出る**。
 *
 * 調査の記録（誤った仮説を再学習させないため）: 当初「headless にカメラが無く
 * `CameraQrScanner.start` が `camera_denied` で即座に scanning から抜ける」と考えたが、
 * **実測で棄却**した（camera-grant の 1.5 秒後に 5 回とも `scanning=1 / cameraError=0`）。
 * headless Chromium でも getUserMedia は失敗せず、`scanning` は安定状態である。
 */
export async function expectCheckinState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('checkin-shell')).toHaveAttribute('data-checkin-state', state);
}

export { expect, type Page };
