import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * iPad 受付端末を主対象とするため、横向き / 縦向きの iPad viewport を
 * プロジェクトとして定義する。詳細なシナリオは issue #21 で拡充する。
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'ipad-landscape',
      use: { ...devices['iPad (gen 7) landscape'] },
    },
    {
      name: 'ipad-portrait',
      use: { ...devices['iPad (gen 7)'] },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
