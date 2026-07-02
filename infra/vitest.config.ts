import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    include: ['test/**/*.{test,spec}.ts'],
    environment: 'node',
    // CDK スタックのフル synth（OpenNext アセットのハッシュ・esbuild バンドル）を伴うテストは、
    // コールドキャッシュや並列実行の負荷で既定 5s を超えることがある。個別 timeout の
    // 付け忘れによるフレークを防ぐため全体で緩める (issue #300 実装時に顕在化)。
    testTimeout: 60000,
  },
});
