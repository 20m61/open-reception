import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
/**
 * 既定はローカル本番ビルド（127.0.0.1）。`PLAYWRIGHT_BASE_URL` を指定すると稼働中の任意 URL
 * （実環境 CloudFront 等）を対象に E2E/smoke を回せる（その場合ローカルサーバは起動しない）。
 */
const remoteBaseURL = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '');
const baseURL = remoteBaseURL ?? `http://127.0.0.1:${PORT}`;

/**
 * iPad 受付端末を主対象とするため、iPad viewport を中心に E2E を回す。
 * 詳細なシナリオは issue #21 で拡充する。
 *
 * ブラウザ選択:
 *  - 既定は chromium で iPad viewport をエミュレートする `chromium-ipad`。これは
 *    全 OS で動くため、ローカル（macOS 13 を含む）の主ゲートに使う。
 *  - 本物の WebKit(Safari) 忠実度が要る `ipad-landscape`/`ipad-portrait` は webkit を使う。
 *    Playwright は **macOS 13 で webkit 非対応**のため、CI（webkit 対応 OS）または
 *    明示フラグ `E2E_WEBKIT=1` のときだけ含める。詳細は docs/quality-gate.md。
 */
const includeWebkit = !!process.env.CI || process.env.E2E_WEBKIT === '1';

/**
 * ブラウザ実行ファイルの明示指定（chromium 系 project 用）。プリインストール済み Chromium の
 * ビルド番号が、インストール済み @playwright/test が期待する版とずれる実行環境（例: Claude Code
 * on the web の /opt/pw-browsers）向けの逃げ道。`playwright install` を走らせずに既存バイナリを
 * 使う（環境ガイド準拠）。`PW_EXECUTABLE_PATH` 未設定時は Playwright の既定解決に委ねるため、
 * 通常環境・CI には無影響。
 */
const chromiumLaunchOptions = process.env.PW_EXECUTABLE_PATH
  ? { executablePath: process.env.PW_EXECUTABLE_PATH }
  : undefined;

// 既定スコープへカスタム受付フローを一時投入する spec (#248)、および共有シングルトン設定
// （voice-store の a11yModesEnabled 等, #321）を一時的に無効化して検証する spec。どちらも
// グローバル状態を書き換えるため、他 kiosk テストと分離し専用 project で本 suite の後に
// 単独実行する（テスト自身は最後に既定値へ戻すが、並行実行中の一瞬の観測を避けるため）。
const FLOW_MUTATING_SPECS = /(admin-reception-flows|kiosk-flow-integration|kiosk-a11y-tenant-toggle)\.spec\.ts$/;

// soak（長時間連続稼働）テストは `tests/e2e/soak/` に隔離し、専用の playwright.soak.config.ts
// （`npm run test:soak*`）からのみ実行する (issue #317)。本設定（既定 `npm run test:e2e` /
// `scripts/quality-gate.sh --pr|--full`）では、testDir の再帰探索に紛れ込まないよう明示的に除外する。
const SOAK_SPECS = /\/soak\//;
const DEFAULT_TEST_IGNORE = [FLOW_MUTATING_SPECS, SOAK_SPECS];

// iPad (gen 7) 縦向き相当のエミュレーション設定（chromium 用）。
const iPadPortraitViewport = {
  viewport: { width: 810, height: 1080 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
} as const;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // 稀な負荷/タイミング由来のフレークを吸収する（CI は 2 回）。フロー作成系との衝突は下記の
  // project 分離で構造的に解消済み (#248)。
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-ipad',
      use: { browserName: 'chromium', ...iPadPortraitViewport, launchOptions: chromiumLaunchOptions },
      testIgnore: DEFAULT_TEST_IGNORE,
    },
    ...(includeWebkit
      ? [
          {
            name: 'ipad-landscape',
            use: { ...devices['iPad (gen 7) landscape'] },
            testIgnore: DEFAULT_TEST_IGNORE,
          },
          {
            name: 'ipad-portrait',
            use: { ...devices['iPad (gen 7)'] },
            testIgnore: DEFAULT_TEST_IGNORE,
          },
        ]
      : []),
    {
      // フロー作成系 spec は既定スコープ（internal/default-site）へカスタムフローを一時投入するため、
      // 他の kiosk テストと並行すると /api/kiosk/flow 経由で漏れて既定フロー検証をフレークさせる
      // (#248)。voice-store の a11yModesEnabled 一時無効化 spec (#321) も同様の理由でここに含める。
      // 本 suite の全 project 完了後に単独実行して構造的に分離する（互いは一意キーで独立）。
      name: 'flow-mutation',
      use: { browserName: 'chromium', ...iPadPortraitViewport, launchOptions: chromiumLaunchOptions },
      testMatch: FLOW_MUTATING_SPECS,
      dependencies: ['chromium-ipad', ...(includeWebkit ? ['ipad-landscape', 'ipad-portrait'] : [])],
    },
  ],
  // 実環境 URL を対象にする場合（PLAYWRIGHT_BASE_URL 指定時）はローカルサーバを起動しない。
  webServer: remoteBaseURL
    ? undefined
    : {
        // /kiosk セッションゲート (issue #239) により enroll 済み kiosk は seed 済みカスタムフローを
        // 表示する。既定（組込み）受付フローを検証する e2e と衝突するため、e2e では dev seed を無効化。
        // env を command に埋め込み、reuseExistingServer での取りこぼしを避ける。
        command: 'RECEPTION_DISABLE_DEV_SEED=1 npm run start',
        url: baseURL,
        // 既存サーバを再利用しない。再利用すると dev seed 無効化フラグ無しで起動した stale サーバに
        // 繋がり、seed 済みカスタムフローが漏れて既定フロー検証が壊れる（#239 レビュー反映）。常に
        // env 注入済みのコマンドで起動する。
        reuseExistingServer: false,
        timeout: 120_000,
        env: { RECEPTION_DISABLE_DEV_SEED: '1' },
      },
});
