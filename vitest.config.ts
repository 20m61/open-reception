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
    // TZ 依存のテスト（例: OutOfHoursView の reopenAt 整形）はホスト TZ ではなく
    // UTC 固定で走らせる（開発機の TZ 設定に関わらず再現性を保つ）。
    env: {
      TZ: 'UTC',
      // 🔴 **unit レーンは AWS 資格情報について hermetic にする（ADR 0010 / #1103）。**
      //
      // これらを固定する前、`instrumentation.test.ts` と `cognito-srp.test.ts` は
      // **開発者の ambient な AWS 資格情報に依存していた**。デプロイ窓を開いている
      // セッションでは実 STS の 3 点が env に載るため、同じ commit でも
      // 「窓が開いているか」でテストの通り方が変わる（2026-09-14 に実際に踏んだ）。
      //
      // Tier 1（pure unit）は定義上 AWS へ到達してはならないので、dummy を明示し、
      // 実資格情報の痕跡を消す。空文字は guard から見て「無い」と等価。
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: '',
      AWS_CREDENTIAL_EXPIRATION: '',
      // 🔴 **アプリの秘密についても同じ理由で hermetic にする（#1021）。**
      //
      // `serverSecret()` は「実デプロイか」を `AWS_LAMBDA_FUNCTION_NAME` で判定し、
      // failClosed の鍵が未設定なら throw する。開発者の shell に `ADMIN_PASSWORD` が
      // 載っているかどうかでテストの通り方が変わってはいけないので、**無い状態**を
      // 既定として固定する（空文字は serverSecret から見て「無い」と等価）。
      // 有る状態を見たいテストは `vi.stubEnv` で自分で立てる。
      ADMIN_PASSWORD: '',
      ADMIN_SESSION_SECRET: '',
      KIOSK_SESSION_SECRET: '',
      CALL_ANSWER_SECRET: '',
      // 🔴 `AWS_LAMBDA_FUNCTION_NAME`（実デプロイ判定のマーカー）は**あえて固定しない**。
      // 秘密ではなく、各テストが自由に立て倒しする分岐マーカーであり、Lambda ランタイム
      // 以外が供給することはない。固定すると `delete` で片付ける既存テスト全部と結合し、
      // 「一覧を手で伸ばす」羽目になる（撤回した #1021 AC5 と同じ「数え上げ」）。
    },
    // 🔴 **一時領域をテストファイルごとに隔離する (#1136)。**
    // `os.tmpdir()` は `process.env.TMPDIR` を呼び出しのたびに読むので、ここで
    // ファイルごとの root へ向けると**どの綴りで作られた一時パスも**その中に落ちる
    // （ソース走査で綴りを数え上げる方式を、レビュー 2 周目の実測を受けて撤回した）。
    // 経緯と残る面は tests/setup/temp-isolation.ts の doc に書いてある。
    // 🔴 **`isolate` を落とさないこと（レビュー 3 周目 MINOR 5 の実測）。**
    //    既定（ファイルごとに別プロセス）だから隔離が成立する。`--no-isolate` /
    //    `singleFork` にすると、skip 全滅ファイルが `TMPDIR` を戻さないまま終わり、
    //    **次のファイルの root がその中に入れ子になる**（1 段につき +17 文字。
    //    上の `sun_path` の余白を食う）。速度改善で触るときはここを読むこと。
    setupFiles: ['./tests/setup/temp-isolation.ts'],
    // soak ハーネスの純ロジック（tests/soak/thresholds.ts）は unit test で高速検証する (#317)。
    // ブラウザ前提の実ループは tests/e2e/soak/*.spec.ts（vitest 対象外・playwright.soak.config.ts）。
    // 音声評価ハーネス（tests/voice-evaluation/）も合成データのみのオフライン純ロジックなので
    // unit test で回す (#365)。実 provider / 実機を要する完全セットは #65 の UAT 手順側。
    // Claude Code フック（scripts/hooks/*.sh）は使い捨ての一時 git リポジトリを相手に
    // 実際に起動して検証する。外部 I/O は一時ディレクトリ内で閉じるので unit で回す。
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'tests/soak/**/*.{test,spec}.ts',
      'tests/voice-evaluation/**/*.{test,spec}.ts',
      'tests/hooks/**/*.{test,spec}.ts',
      // playwright.config.ts の「壊れても他のテストが赤くならない」設定を固定する
      // 静的メタテスト（tests/hooks と同じく、インフラ設定を unit で押さえる位置づけ）。
      'tests/config/**/*.{test,spec}.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
