import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // soak ハーネスの純ロジック（tests/soak/thresholds.ts）は unit test で高速検証する (#317)。
    // ブラウザ前提の実ループは tests/e2e/soak/*.spec.ts（vitest 対象外・playwright.soak.config.ts）。
    // 音声評価ハーネス（tests/voice-evaluation/）も合成データのみのオフライン純ロジックなので
    // unit test で回す (#365)。実 provider / 実機を要する完全セットは #65 の UAT 手順側。
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/soak/**/*.{test,spec}.ts',
      'tests/voice-evaluation/**/*.{test,spec}.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
