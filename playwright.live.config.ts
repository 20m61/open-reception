import { defineConfig, devices } from '@playwright/test';

/**
 * 実デプロイに対する iPad エミュレーション e2e (#372 実機前検証)。
 *
 * ## 通常の e2e と分ける理由
 *
 * - **実 URL と実データを触る。** ローカルの seed ではなく、稼働中の環境の状態に依存する
 * - **管理者資格情報が要る**（Cognito）。品質ゲートで常時走らせるものではない
 * - 失敗が「コードの欠陥」とは限らない（環境未整備・トークン失効など）。ゲートに混ぜると
 *   赤の意味が薄れる
 *
 * `scripts/e2e-live.sh` から起動する。`npm run test:e2e`（ゲート）には含めない。
 *
 * ## なぜ chromium で iPad をエミュレートするか
 *
 * `devices['iPad (gen 7) landscape']` は WebKit 前提で、macOS 13 では起動できない
 * （`playwright.config.ts` が `E2E_WEBKIT=1` の opt-in にしているのと同じ理由）。
 * ビューポート・タッチ・DPR を iPad 相当に寄せた chromium で代替する。
 *
 * **これは実機の代替ではない。** 実機でしか分からないもの（実際の指の当たり、屋内照明での
 * 視認性、初見の人の迷い）は埋まらない。埋まるのは「その画面サイズで導線が壊れていないか」まで。
 */
const baseURL = process.env.LIVE_BASE_URL?.replace(/\/$/, '');

export default defineConfig({
  testDir: './tests/e2e-live',
  // 実環境を触るので直列。並行すると同じ端末レコードを奪い合う。
  workers: 1,
  fullyParallel: false,
  // 失効トークンや一時的なネットワーク断で落ちることがある。1 回だけ再試行する。
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'ipad-landscape',
      use: {
        ...devices['Desktop Chrome'],
        // iPad (gen 7) 横向き相当。受付端末は横向き固定運用。
        viewport: { width: 1080, height: 810 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: true,
      },
    },
  ],
});
