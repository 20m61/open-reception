import { test as base, expect, type Page } from '@playwright/test';
import { establishKioskSession } from './helpers';

/**
 * kiosk セッションを自動確立する test フィクスチャ (issue #239)。
 *
 * `/kiosk` は kiosk セッション必須になった（未保持なら受付フローを出さず「未エンロール」誘導）。
 * `/kiosk` を直接 goto して受付フローを検証する spec は、`@playwright/test` ではなくこのファイルから
 * `test` を import することで、各テストの最初に PIN 許可 API でセッション cookie を確立する
 * （`page.request` は BrowserContext と cookie を共有するため以降の goto も認証済みになる）。
 *
 * 既定 PIN `0000`・既定 kioskId `kiosk-dev` で許可する。`pinRequired` 設定に依らず成立する
 * （許可 API は PIN 一致でセッションを発行する）。未エンロール/未認証状態を検証する spec は
 * これを使わず `@playwright/test` の素の `test` を使うこと。
 */
export const test = base.extend({
  page: async ({ page, browser }, use) => {
    await establishKioskSession(page, browser);
    await use(page);
  },
});

export { expect, type Page };
