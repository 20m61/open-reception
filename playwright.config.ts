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
  // 共有 in-memory バックエンドのため、フロー作成系テスト（admin-reception-flows /
  // kiosk-flow-integration）の作成中ウィンドウに kiosk テストが当たると稀にフレークする
  // （作成フローは afterEach で削除し持続汚染は無い）。ローカルも 1 回再試行して吸収する。
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium-ipad',
      use: { browserName: 'chromium', ...iPadPortraitViewport },
    },
    ...(includeWebkit
      ? [
          {
            name: 'ipad-landscape',
            use: { ...devices['iPad (gen 7) landscape'] },
          },
          {
            name: 'ipad-portrait',
            use: { ...devices['iPad (gen 7)'] },
          },
        ]
      : []),
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
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { RECEPTION_DISABLE_DEV_SEED: '1' },
      },
});
