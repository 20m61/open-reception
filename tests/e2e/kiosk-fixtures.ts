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

export { expect, type Page };
