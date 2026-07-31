import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
/**
 * 既定はローカル本番ビルド（127.0.0.1）。`PLAYWRIGHT_BASE_URL` を指定すると稼働中の任意 URL
 * （実環境 CloudFront 等）を対象に E2E/smoke を回せる（その場合ローカルサーバは起動しない）。
 */
const remoteBaseURL = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '');
const baseURL = remoteBaseURL ?? `http://127.0.0.1:${PORT}`;

/**
 * platform エリア（developer ロール専用）検証用の**別プロセス**。
 *
 * password セッションが developer になるのは `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` の
 * ときだけで、これは `buildActorConfig`（src/lib/auth/actor.ts）が**プロセス env** から読む。
 * email allowlist 経路は email を持つ identity 専用で、password セッションには適用できない。
 * → **テスト側の helper では developer セッションを張れない。サーバを分けるしかない。**
 *
 * 既定サーバの env に足す案は却下: 全 password ログインが developer 化し、admin 側 e2e の意味
 * （TenantSwitcher の母集合、テナント境界の検証）が変わる。第 85 wave まで `/platform/*` の
 * e2e が 1 本も実効していなかったのはこの制約が未解決だったため (#423)。
 */
const PLATFORM_PORT = Number(process.env.PLATFORM_PORT ?? PORT + 1);
const platformBaseURL = `http://127.0.0.1:${PLATFORM_PORT}`;

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
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';

/**
 * `PW_EXECUTABLE_PATH` 未設定でも、プリインストール済み Chromium が在る環境では自動でそれを使う。
 * env を明示し忘れると「e2e はこの環境では動かない」と誤って結論づけられる（実際に第 15 wave の
 * 申し送りがそう記録され、5 周にわたって stale なまま引き継がれた）。存在しない環境では
 * undefined = Playwright の既定解決に委ねるため、通常環境・CI には無影響。
 */
function resolveChromiumExecutablePath(): string | undefined {
  if (process.env.PW_EXECUTABLE_PATH) return process.env.PW_EXECUTABLE_PATH;
  return existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;
}

const executablePath = resolveChromiumExecutablePath();

/**
 * headless Chromium には実カメラが無く、`getUserMedia` は起動から **1.5〜2 秒後に**拒否される。
 * QR 受付の `scanning` はその窓の間だけ存在する**過渡状態**になり、負荷が高いと（`--full` 等）
 * assert が窓を跨いで `element(s) not found` で落ちる (#361)。フェイクデバイスを与えると
 * `getUserMedia` が成功し、`scanning` は scan timeout（30s）まで安定する。
 *
 * 実 `CameraQrScanner` の経路（権限要求 → track 取得 → デコードループ）はそのまま踏むので、
 * 検証内容は落ちない。映像が既知のテストパターンになるだけ。
 *
 * **既知の制約**: これは chromium 専用フラグで、`ipad-landscape` / `ipad-portrait`（webkit）には
 * 効かない。両 project は macOS 13 では走らず `E2E_WEBKIT=1` の opt-in 時のみ有効なので、
 * 現状のゲートには影響しない。webkit を常用するなら別途 QR 受付 spec の扱いを決める必要がある。
 */
const FAKE_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

// executablePath の解決と**マージ**する（置き換えると Claude Code on the web の
// プリインストール Chromium 解決が壊れる）。
const chromiumLaunchOptions = {
  args: FAKE_MEDIA_ARGS,
  ...(executablePath ? { executablePath } : {}),
};

// 既定スコープへカスタム受付フローを一時投入する spec (#248)、および共有シングルトン設定
// （voice-store の a11yModesEnabled 等, #321）を一時的に無効化して検証する spec。どちらも
// グローバル状態を書き換えるため、他 kiosk テストと分離し専用 project で本 suite の後に
// 単独実行する（テスト自身は最後に既定値へ戻すが、並行実行中の一瞬の観測を避けるため）。
// **フローを作る spec 同士は互いに並行させない。**
//
// 従来はこの 3 本を 1 つの project へまとめていたが、project 内は `fullyParallel` で
// **並行実行される**ため、`admin-reception-flows` と `kiosk-flow-integration` が同時に
// 既定スコープのフローを作り合っていた。結果、kiosk が他 spec のフローを掴んだり
// （画面に `並び替えA-*` が出た）、一覧の順序検証中に他 spec の afterEach で対象が
// 消えたり（`indexOf` が -1）する。project を分けたのは**他 project との**分離であって、
// **project 内の**分離にはなっていなかった。
//
// 既存の `pristine-state → chromium-ipad → flow-mutation` と同じく `dependencies` で
// 連鎖させ、2 本が重ならないようにする。
const FLOW_MUTATING_SPECS = /(admin-reception-flows|kiosk-a11y-tenant-toggle)\.spec\.ts$/;

/** 上記の後に**単独で**走らせるフロー変更 spec（`flow-mutation` と同時に走らせない）。 */
const FLOW_MUTATING_KIOSK_SPECS = /kiosk-flow-integration\.spec\.ts$/;

// soak（長時間連続稼働）テストは `tests/e2e/soak/` に隔離し、専用の playwright.soak.config.ts
// （`npm run test:soak*`）からのみ実行する (issue #317)。本設定（既定 `npm run test:e2e` /
// `scripts/quality-gate.sh --pr|--full`）では、testDir の再帰探索に紛れ込まないよう明示的に除外する。
const SOAK_SPECS = /\/soak\//;

// 既定シード状態（在館者ゼロ・担当者は seed のみ）を前提に検証する spec。他 spec が作った
// 来訪者や担当者が残っていると、空状態の文言（checkout-empty）や画面の高さ（VRT baseline）が
// 変わって決定的に失敗する。**本 suite より先に**単独実行して構造的に分離する
// （逆側の分離である flow-mutation は本 suite の後。両者で前後を挟む形）。
const PRISTINE_STATE_SPECS = /(kiosk-checkout-i18n|kiosk-vrt-a11y)\.spec\.ts$/;

// developer ロール専用の platform エリアを検証する spec。上記 platformBaseURL の別プロセス
// （passwordRole=developer）へ向けた `platform-developer` project だけが実行する。
// **命名規約**: `tests/e2e/platform-*.spec.ts` は developer サーバで走る。新規に足すときは
// この接頭辞にすれば config を触らずに済む（`capture-screens-platform` だけは撮影 spec の
// 一群に名前を寄せたいので明示）。
const PLATFORM_SPECS = /(platform-[a-z0-9-]+|capture-screens-platform)\.spec\.ts$/;

const DEFAULT_TEST_IGNORE = [
  FLOW_MUTATING_SPECS,
  FLOW_MUTATING_KIOSK_SPECS,
  PRISTINE_STATE_SPECS,
  PLATFORM_SPECS,
  SOAK_SPECS,
];

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
  /**
   * **欠落した VRT ベースラインを自動生成しない。**
   *
   * Playwright の既定 `'missing'` は、baseline が無いとその場の描画を新 baseline として
   * 書き込む。上の `retries` と組み合わさると **1 回目が baseline を書いて落ち、retry が
   * 通る**ため、**誰もレビューしていない描画が「正」として焼き付いたまま suite は green**
   * になる。`snapshotPathTemplate` の注記（project 名を固定してレビュー済み baseline を
   * 孤立させない）と同じ事故を、別経路で起こさないための封じ手。
   *
   * baseline は実行プラットフォームでしか作れず、現在 linux は 4 枚欠けている
   * （結果系 4 状態は darwin のみで生成された）。Linux 実行環境（Claude Code on the web 等）
   * へ移した瞬間にこの経路を踏むので、黙って生成させず**落として気づかせる**。
   *
   * 意図的な取り直しは CLI の `--update-snapshots` が上書きするのでそちらで行い、
   * **差分を見てからコミットする**。
   */
  updateSnapshots: 'none',
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      // 既定シード状態を前提にする spec を最初に流す（下記 chromium-ipad が依存）。
      name: 'pristine-state',
      use: { browserName: 'chromium', ...iPadPortraitViewport, launchOptions: chromiumLaunchOptions },
      testMatch: PRISTINE_STATE_SPECS,
      // VRT の baseline 名は既定で project 名を含む。project を分けただけで別名になると、
      // **レビュー済み baseline が孤立し、その場の描画が新 baseline として自動生成される**
      // （＝退行がそのまま「正」として焼き付く）。既存の `chromium-ipad` 名に固定して、
      // 第 14 wave でレビューされた baseline と比較し続ける。
      snapshotPathTemplate:
        '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-chromium-ipad-{platform}{ext}',
    },
    {
      name: 'chromium-ipad',
      use: { browserName: 'chromium', ...iPadPortraitViewport, launchOptions: chromiumLaunchOptions },
      testIgnore: DEFAULT_TEST_IGNORE,
      dependencies: ['pristine-state'],
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
    {
      // **`flow-mutation` の後に単独で走る。** 同時に走らせると、双方が既定スコープへ
      // カスタムフローを作り合って互いの検証を壊す（詳細は FLOW_MUTATING_SPECS の注記）。
      name: 'flow-mutation-kiosk',
      use: { browserName: 'chromium', ...iPadPortraitViewport, launchOptions: chromiumLaunchOptions },
      testMatch: FLOW_MUTATING_KIOSK_SPECS,
      dependencies: ['flow-mutation'],
    },
    // platform は developer 専用サーバ（別ポート・別プロセス）へ向ける。実サーバを起こせない
    // 実環境向け実行（PLAYWRIGHT_BASE_URL 指定）では passwordRole を制御できないため project ごと落とす
    // — 走らせても admin へリダイレクトされて必ず落ちる（それは実環境の欠陥ではなく実行方法の欠陥）。
    // 他 project とは別プロセスなので並行実行しても状態が混ざらない（依存なし＝壁時計を増やさない）。
    ...(remoteBaseURL
      ? []
      : [
          {
            name: 'platform-developer',
            use: {
              browserName: 'chromium' as const,
              baseURL: platformBaseURL,
              viewport: { width: 1280, height: 900 },
              launchOptions: chromiumLaunchOptions,
            },
            testMatch: PLATFORM_SPECS,
          },
        ]),
  ],
  // 実環境 URL を対象にする場合（PLAYWRIGHT_BASE_URL 指定時）はローカルサーバを起動しない。
  webServer: remoteBaseURL
    ? undefined
    : [
        {
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
        {
          // platform-developer project 専用。passwordRole=developer は**このプロセスに閉じる**ので、
          // 上の既定サーバ（= admin 側 e2e の対象）の認可の意味は一切変わらない。
          // 上と同じく env を command にも埋め、reuse 経路での取りこぼしを避ける。
          command: `RECEPTION_DISABLE_DEV_SEED=1 OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer PORT=${PLATFORM_PORT} npm run start`,
          url: platformBaseURL,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            RECEPTION_DISABLE_DEV_SEED: '1',
            OPEN_RECEPTION_ADMIN_PASSWORD_ROLE: 'developer',
            PORT: String(PLATFORM_PORT),
          },
        },
      ],
});
