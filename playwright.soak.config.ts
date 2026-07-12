import { defineConfig } from '@playwright/test';
import { parseSoakMode } from './tests/soak/thresholds';

/**
 * 1 営業日連続稼働 soak テスト専用の Playwright 設定 (issue #317)。
 *
 * `playwright.config.ts`（既定 `npm run test:e2e` / `scripts/quality-gate.sh --pr|--full`）
 * とは意図的に別ファイルへ分離している。soak は長時間モード（30m/2h/8h）ではテスト単体の
 * 実行時間がゲートの前提（分オーダー）を大きく超えるため、既定ゲートに紛れ込ませず
 * `npm run test:soak*` からのみ opt-in で実行できるようにする。
 * `tests/e2e/soak/` は `playwright.config.ts` 側でも `testIgnore` により二重に除外している。
 */

const PORT = Number(process.env.PORT ?? 3000);
const remoteBaseURL = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '');
const baseURL = remoteBaseURL ?? `http://127.0.0.1:${PORT}`;

/**
 * モードごとの Playwright テストタイムアウト（ハーネス内のループ予算 + 余裕）。
 * ループ自体の予算（totalMs）は `tests/soak/thresholds.ts` の `parseSoakMode` が
 * 単一の情報源として定義する。ここでは Playwright 側のタイムアウトに変換するだけで、
 * 値を重複定義しない。ループ内の障害注入待機・アサーション待ちの余裕として 5 分を追加する。
 */
const soakTimeoutMs = parseSoakMode(process.env.SOAK_MODE).totalMs + 5 * 60_000;

export default defineConfig({
  testDir: './tests/e2e/soak',
  fullyParallel: false,
  // soak は 1 本のブラウザで長時間ループする性質上、リトライしても意味が薄く時間だけ食うため無効化。
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: soakTimeoutMs,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'soak',
      use: {
        browserName: 'chromium',
        viewport: { width: 810, height: 1080 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: remoteBaseURL
    ? undefined
    : {
        command: 'RECEPTION_DISABLE_DEV_SEED=1 npm run start',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        env: { RECEPTION_DISABLE_DEV_SEED: '1' },
      },
});
