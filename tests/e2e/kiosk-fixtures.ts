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
 * 調査の記録（誤った結論を再学習させないため）:
 *
 * 第 91 wave で「headless にカメラが無く `CameraQrScanner` が `camera_denied` へ落ちる」という
 * 仮説を **実測で棄却したと書いたが、その棄却自体が誤り**だった。原因は **1 点サンプリング** —
 * camera-grant の 1.5 秒後だけを 5 回見て `scanning=1` だったので「安定」と結論づけていた。
 *
 * 第 92 wave で時間軸に沿って 35 点サンプリングし直した結果（フェイクデバイス無し）:
 * `0s=scanning 1s=scanning 2s=cameraError 3s=cameraError ... 34s=cameraError`。
 * **`scanning` は約 2 秒だけの過渡状態**で、1 点観測はちょうど境界の内側を踏んでいた。
 * 負荷が高い（`--full` 等）と assert が窓を跨ぎ、以後ずっと `element(s) not found` になる。
 *
 * 対策は `playwright.config.ts` の `FAKE_MEDIA_ARGS`（フェイクカメラ）。同じ 35 点計測で
 * `0s..30s=scanning 31s=scanError`（31s は scan timeout）となり `scanning` は安定した。
 *
 * **教訓: 過渡状態の有無を 1 点で判定しない。時間軸で複数点を取る。**
 */
export async function expectCheckinState(page: Page, state: string): Promise<void> {
  await expect(page.getByTestId('checkin-shell')).toHaveAttribute('data-checkin-state', state);
}

export { expect, type Page };

/**
 * 担当者カードを出す (#787)。
 *
 * 相手選択画面は**未入力時に部署カードを出す**ようになった（担当者が数十人のテナントで
 * ファーストビューが埋まるのを避けるため）。担当者カードへ到達するには部署を 1 つ開く。
 *
 * 🔴 **spec 側で `staff-group-*` を直接押さない。** どの担当者がどの部署に居るかは
 * fixture の都合で変わる。ここで「その担当者を含む群を開く」まで面倒を見る ——
 * spec は「誰を選ぶか」だけを書けばよい。
 *
 * 検索経路は群を跨ぐので、こちらは**検索でも到達できる**ことの裏返しでもある。
 */
export async function revealStaff(page: Page, staffTestId: string): Promise<void> {
  const card = page.getByTestId(staffTestId);
  if (await card.isVisible().catch(() => false)) return;

  const groups = page.getByTestId('staff-groups');
  if (!(await groups.isVisible().catch(() => false))) return;

  const buttons = await groups.locator('button[data-testid^="staff-group-"]').all();
  for (const button of buttons) {
    await button.click();
    if (await card.isVisible().catch(() => false)) return;
    // この群には居なかった。部署を選び直して次を試す。
    await page.getByTestId('staff-group-back').click();
  }
  throw new Error(`${staffTestId} がどの部署にも見つかりませんでした`);
}
