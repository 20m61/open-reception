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
    // CDK の synth 出力を周回ごとの一時 root へ閉じ込めて終了時に消す (#721)。
    // 放置すると `/tmp/cdk.out*` が積み上がり、クラウドのディスクを食い潰して
    // **e2e が落ちる**（原因が症状から読めないので、掃除だけでなく設計で塞ぐ）。
    globalSetup: ['./test/setup/cdk-outdir.ts'],
  },
});
