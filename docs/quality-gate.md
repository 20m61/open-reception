# 品質ゲート（Lighthouse / アクセシビリティ） (issue #38)

受付端末は kiosk 的に長時間表示され来訪者が直接操作するため、パフォーマンス・
アクセシビリティ・タッチ操作性の劣化を早期に検知する。

**本リポジトリは GitHub Actions を使用しない方針**のため、品質ゲートは
ローカル（または将来 Actions 以外の CI を採用する場合はそのランナー）で実行する。

## 実行コマンド

```bash
npm run verify        # typecheck / lint / unit / build
npm run test:e2e      # iPad viewport の E2E（axe a11y を含む）
npm run lighthouse    # Lighthouse CI（performance / accessibility / best-practices / seo）
```

### どのタイミングでどのゲートを適用するか

実測（`--full` 5 回の平均・2026-07-30）: 合計 **598s ≈ 10 分**。内訳は
e2e 265s (44%) / unit 86s (14%) / lighthouse 70s (12%) / build 62s (10%) /
sast 49s (8%) / lint 37s (6%) / typecheck 25s (4%) / secrets + audit 4s。

| タイミング | 何を回すか | 実測 | なぜ |
| --- | --- | --- | --- |
| 1 ファイルを直している間 | `npx vitest run <path>` | **0.3〜1s** | `npm test` の 95s を払わない。red → green の確認回数がそのまま増える |
| 各変更ごと | `--fast` | 148s | typecheck + lint + unit |
| PR 前（フック必須） | `--pr` | 210s | + build |
| UI / a11y / VRT に触れた変更 | `--pr --e2e` | 475s | VRT 差分は**閾値内でも実物を見る**（`maxDiffPixelRatio` に本物の崩れが隠れた実績あり） |
| マージ前（フック必須） | `--full` | 598s / **152s** | 文書のみの変更では下記の省略が効く |
| 定期 | `--full --strict` | — | SKIP を FAIL 扱い。記録は `docs/gate-runs.md`（本書「定期運用」節） |

### 変更範囲による省略（docs スコープ）

`build` / `e2e` / `lighthouse` / `sast` は**ソースを入力に取る**。文書だけを触った周回では
その入力が 1 バイトも変わらないので、結果は前回と同一にしかならない。それでも毎回 10 分
払っていた（あるセッションでは 5 PR 中 3 本が文書のみ）。`scripts/change-scope.ts` が
「文書のみ」と判定した場合、この 4 つを SKIP する（**598s → 約 152s**）。

- 判定は `src/domain/governance/change-scope.ts`（純関数・ユニットテスト済）。**省略してよい
  ステップ名の一覧もここが唯一の真実源**で、shell は `skip=<step>` の出力を読むだけ。
- **厳しい方へ倒す。** `docs/**`・ルートの `*.md`・`.github/**/*.md`・`LICENSE` **だけ**が
  docs 扱い。allowlist の補集合で判定するので、未知の種類のファイルが増えたら自動的に
  `code` 側（＝全ステップ実行）へ落ちる。変更ゼロも `code`（収集失敗の可能性があるため）。
  起点（`origin/main`）が解決できないときも `code`。
- **`typecheck` / `lint` / `unit` は docs でも回す。** 判定器自体のバグでソースが混ざった
  場合の**トリップワイヤ**（148s と安い）。`secrets` も回す（文書にも鍵は混入しうる）。
- 有効性の担保は**指紋側**。省略はそのツリーに対してのみ成立し、コードを 1 文字でも触れば
  指紋が変わって記録は無効になる。スタンプの 4 列目に scope を残すので、後から
  「なぜ e2e が走っていないのか」を追える。
- `--no-skip-docs` で無効化して tier の全ステップを実行できる。
- **残件**: 文書 PR で省略し続けた分を定期実行で必ず一度は踏む網（`--full --strict` の
  頻度と起点の設計）は未整備。現状の担保はトリップワイヤのみ。

### ゲートの強制（`pr-gate-guard` フック）

CI が無い以上、「PR 前に `--pr` / マージ前に `--full`」は**規約だけでは守られない**。
そのため Claude Code の PreToolUse フック `scripts/hooks/pr-gate-guard.sh`
（`.claude/settings.json` で登録・チーム共通）が `gh pr create` / `gh pr merge` を
実行直前に捕まえ、**現在の作業ツリーに対する green 記録が無ければブロック**する。

- 記録（スタンプ）は `quality-gate.sh` が PASS 時に `.git/open-reception-gate-stamp`
  へ追記する。コミットされず、**worktree ごとに独立**（並列トラックが互いの結果を
  流用できない）。実装は `scripts/lib/gate-stamp.sh`。
- 記録は「そのゲートが実際に検査したツリー」に紐づく。HEAD・追跡ファイルの差分・
  未追跡（非 ignore）ファイルの内容から指紋を採るため、**ゲート後に 1 文字でも編集
  すれば stale として無効**になり、走らせ直しが要る。`.gitignore` 済み（`node_modules`・
  `.next` 等）は指紋に影響しない。
- 要求 tier は `gh pr create` → `--pr` 以上、`gh pr merge` → `--full`
  （`feedback: merge-gate`）。`--fast` だけでは PR を作れない。
- 意図的な迂回は明示的に行う: `OPEN_RECEPTION_SKIP_GATE_GUARD=1 gh pr create ...`。
- 振る舞いは `tests/hooks/pr-gate-guard.test.ts` で検証している（`npm test` に載る）。

### E2E のブラウザ（macOS 13 対応）

E2E は iPad 受付端末を主対象とするが、ブラウザは 2 系統で回す（`playwright.config.ts`）。

| プロジェクト | ブラウザ | 既定で実行 | 用途 |
| --- | --- | --- | --- |
| `chromium-ipad` | chromium（iPad viewport エミュレート） | ✅ 常時 | ローカル主ゲート。全 OS で動く |
| `ipad-landscape` / `ipad-portrait` | webkit（Safari 忠実度） | CI または `E2E_WEBKIT=1` 時のみ | 実 Safari 相当の検証 |

**Playwright は macOS 13 (Ventura) で webkit 非対応**（`playwright install webkit` が
`does not support webkit on mac13` で失敗する）。このため macOS 13 のローカルでは
`chromium-ipad` のみが既定で走り、webkit プロジェクトは自動的に除外される。実 Safari
忠実度が要る検証は webkit 対応 OS の CI、または明示的に `E2E_WEBKIT=1 npm run test:e2e`
で実行する（webkit が入っている環境が前提）。

`npm run lighthouse` は本番ビルドを `npm run start` で起動し、主要ルートを検査する
（`lighthouserc.json`）。Chrome が必要で、`CHROME_PATH` で明示できる。

```bash
# 例: Playwright の Chromium を使う
CHROME_PATH=/path/to/chrome npm run build && npm run lighthouse
```

## 対象ルート（PR smoke）

- `/`（入口）
- `/kiosk`（受付待機）
- `/admin/login`（管理ログイン）

main / nightly では主要画面（目的選択・担当者選択・入力・呼び出し中・結果）まで
広げることを推奨する。VRM / 音声 / 通信は mock 可能な状態で検査する。

## 閾値（段階導入）

| 指標 | 閾値 | 区分 |
| --- | --- | --- |
| Accessibility | ≥ 0.90 | error（未満で失敗） |
| Best Practices | ≥ 0.90 | error（未満で失敗） |
| Performance | ≥ 0.70 | warn（CI 環境差が大きいため大幅劣化検知を重視） |
| SEO | 参考値 | off（kiosk アプリのため必須にしない） |
| axe critical / serious | 0 件 | E2E（`tests/e2e/a11y.spec.ts`、#7） |
| axe moderate | 原則 0 件 | 例外は理由を記録 |

### 現状の参考スコア（ローカル測定）

| ルート | Performance | Accessibility | Best Practices |
| --- | --- | --- | --- |
| `/` | ~0.99 | 0.92 | 0.96 |
| `/kiosk` | ~1.0 | 0.92 | 0.96 |
| `/admin/login` | ~1.0 | 0.93 | 0.96 |

## 例外・注意

- Performance は CI 環境差が出るため、初期は絶対値より**大幅劣化の検知**を重視する（warn）。
- 本番相当の重い VRM アセットは常時検査せず、PR では軽量 fixture を使う。
- iPad / Safari 固有の問題は Playwright WebKit smoke（iPad viewport）でも補完する。
- アクセシビリティの最重大（critical/serious）違反は E2E（axe）で 0 件をゲートする。

## 受付UXの安全性・プライバシーゲート（#125 / Epic #119）

タッチ受付UXは公共空間で使うため、見た目・会話だけでなく以下を E2E ゲートで担保する。

- **a11y（深部・画面種別）**: `tests/e2e/a11y.spec.ts` で待機/トップ/管理ログインに加え、
  呼び出し直前の**確認画面**、および **iPad 横置き / 大型横画面**の待機画面でも axe critical 0 件を検証。
- **プライバシー非保持**: `tests/e2e/kiosk-privacy.spec.ts` で、完了/キャンセル後にリロード
  せず次の受付へ進んでも来訪者の氏名（PII）が残らないことを検証（アプリ状態としての非保持）。
- **呼び出し前の確認必須**: 確認画面を経ずに結果へ遷移しないことを検証（安全側の明示確認）。
- 受付の主要分岐（成功/未応答/失敗・代替導線・待機復帰）は `tests/e2e/reception-flow.spec.ts`。

> inc2 予定: 主要 viewport のスクリーンショット差分、音声/カメラ/VRM/TTS/STT 失敗時の
> フォールバックの網羅、キーボード/スイッチ操作の検証。

## 定期運用（`--full`、#318）

`scripts/quality-gate.sh --full`（secrets/sast/audit/e2e/lighthouse）は「マージ前・定期」
の重ゲートと位置づけているが、コード変更を伴わない PR がしばらく無い期間でも依存脆弱性・
secret 混入・ライセンス問題（#105 方針）は時間経過だけで発生し得る。マージ駆動の `--pr`
ゲートだけでは検出が漏れるため、以下の運用で**定期実行**を仕組み化する。

### 定期実行方式

- **推奨**: Claude Code の Routine（`create_trigger`、cron 週次、例:
  毎週月曜 09:00 JST）で `./scripts/quality-gate.sh --full --strict` を実行させる。
  Routine のプロンプトには「実行後、結果を下記フォーマットで `docs/gate-runs.md` に追記し、
  FAIL があれば下記の FAIL 時ハンドリングに従って issue を起票する」まで含める
  （`scripts/record-gate-run.sh` を使うと記録部分を自動化できる）。
  - 本 Issue (#318) 自体はこの仕組みを**文書化**するのみで、実際の Routine 作成は
    ユーザーの判断で行う（自動では作成しない）。
- **代替**: Claude Code Routine が使えない環境では、開発マシンのローカル cron/launchd で
  同等のコマンドを週次実行する。例（cron）:
  ```cron
  0 9 * * 1 cd /path/to/open-reception && ./scripts/record-gate-run.sh >> /tmp/open-reception-gate.log 2>&1
  ```
- **GitHub Actions は使わない方針を維持する**。定期実行はあくまでローカル実行 or
  Claude Code Routine 経由で、Actions 相当の外部 CI は導入しない。
- 実行頻度は**週次以上**（週次を既定、依存監査の重大度が高い時期は前倒しで手動実行してよい）。

### 記録先・形式: `docs/gate-runs.md`

- 毎回の `--full` 実行結果を `docs/gate-runs.md` の表へ**追記**する（append-only、既存行は
  書き換えない）。列は次の通り。

  | 列 | 内容 |
  | --- | --- |
  | 日時 (UTC) | 実行開始時刻。`date -u +"%Y-%m-%dT%H:%MZ"` |
  | コミット SHA | 実行時の `git rev-parse --short HEAD` |
  | tier | 通常は `full`（`--strict` 併用が定期実行の必須条件、後述） |
  | 結果 | `PASS` / `FAIL` |
  | SKIP 項目 | 未導入ツール等で SKIP になった項目（`--strict` 下では発生しない想定。発生時はそれ自体が FAIL 扱い） |
  | 起票 Issue / 備考 | FAIL 時の issue 番号、ツール追従作業のメモ等 |

- 手動追記でも、`scripts/record-gate-run.sh`（本 Issue で追加、任意）を使った自動追記でも良い。

### FAIL 時のハンドリング

FAIL したステップの重大度に応じて**即時 issue を起票**し、対応期限を設ける。

| 重大度 | 該当例 | 対応期限 |
| --- | --- | --- |
| Critical | gitleaks で secret 検出、npm audit の critical、semgrep のセキュリティ error | 起票から **24 時間以内**に着手 |
| High | npm audit の high、e2e a11y critical/serious（axe） | 起票から **3 営業日以内** |
| Moderate 以下 | npm audit の moderate 以下、lighthouse の warn 系劣化 | 次スプリント（**2 週間**）以内 |

- 起票する issue には、`docs/gate-runs.md` の該当行・実行ログの要約（該当ステップの出力抜粋）・
  再現コマンド（`./scripts/quality-gate.sh --full --strict` あるいは個別トグル）を含める。
- 対応完了後は再度 `--full --strict` を実行して green を確認し、issue をクローズしてから
  `docs/gate-runs.md` に PASS の行を追記する（FAIL 行は削除・改変しない。履歴として残す）。

### ツールのバージョン・ルール更新への追従方針

- `gitleaks` / `semgrep` はローカルインストールのツール（npm 管理外）で、脆弱性・秘密情報の
  検出ルールは日々更新される。**四半期に一度**、`gitleaks version` / `semgrep --version` を
  最新リリースと比較し、メジャー更新があれば変更点（`semgrep scan --config p/default` の
  ルールセット変更含む）を確認してから追従する。追従作業自体も `docs/gate-runs.md` の
  備考欄に記録する（例: 「semgrep 1.x→1.y 追従」）。
- `npm audit` は実行のたびに最新の advisory DB を参照するため、追従は定期実行の副次効果として
  自動的に行われる。

### 未導入ツールの扱い（定期実行では SKIP=FAIL）

- 通常運用（`--pr` 等、各変更ごと）では未導入ツールは SKIP 表示のみで許容する。
- **定期実行（`--full`）では必ず `--strict` を付与し、SKIP を FAIL 扱いにする。** これにより
  「ツールが未導入のまま気づかずゲートが素通りする」事故を防ぐ。SKIP=FAIL になった場合も
  上表の重大度表に従って issue を起票する（対象ツールの導入自体をタスク化する）。

### 変更範囲による省略との関係

`--strict` は**変更範囲による省略（docs スコープ）を無効化する**（`effectiveScope`）。
定期実行は「コードが変わっていないのに劣化するもの」——依存 advisory の更新・ブラウザ更新・
gitleaks/semgrep のルール変更——を捕まえるための実行なので、文書のみのブランチで走ったからと
いって `e2e` や `sast` を省略したら**その実行が存在する意味が無くなる**。倒す方向は
`docs` → `code` の一方通行で、`code` を緩めることはしない。

つまり役割分担はこうなる。

| 何を守るか | 誰が守るか |
| --- | --- |
| コード変更による退行 | マージ前の `--full`（コードが変われば scope は必ず `code`） |
| コード非変更の時間経過による劣化 | **定期の `--full --strict`**（省略しない） |

### 現状（2026-07-30）

**定期実行は一度も回っていない。** 下記の `docs/gate-runs.md` は EXAMPLE 行のみで実運用の記録が
0 件。本節が「実際の Routine 作成はユーザーの判断で行う（自動では作成しない）」と定めている
ためで、仕組みは文書化済み・**実行の設定がユーザー操作として未了**という状態。
稼働環境が要る検査（`scripts/url-quality-gate.sh` の ZAP・live lighthouse）は dev 環境削除
（2026-07-24）以降回せておらず #65 にスタックしている。

## 1 営業日連続稼働 soak テスト（#317, charter 成功指標）

PROJECT_CHARTER の成功指標「受付端末として 1 営業日以上の連続稼働テストに耐える」を検証する
soak ハーネス。長時間表示で顕在化する問題（メモリリーク・DOM ノード堆積・heartbeat 欠落・
自動復旧 (#30) の劣化）は `--pr`/`--full` の通常ゲートでは検出できないため、別建てで運用する。

**既定の `npm run test:e2e` / `scripts/quality-gate.sh --pr|--full` の対象には含まれない。**
`playwright.config.ts` の `testIgnore` と、専用設定ファイル `playwright.soak.config.ts`
（テスト自体も `tests/e2e/soak/` に隔離）の二重の仕組みで構造的に分離している。

### 実行コマンド・モード

```bash
npm run test:soak       # 既定 = smoke（2 分）。ローカル/dev URL に対して毎回検証できる短時間版
npm run test:soak:30m   # opt-in（30 分）
npm run test:soak:2h    # opt-in（2 時間）
npm run test:soak:8h    # opt-in（8 時間。1 営業日の一部相当）
```

`SOAK_MODE` 環境変数（`smoke` 既定 / `30m` / `2h` / `8h`）でモードを切り替える。各モードの
totalMs・サンプリング間隔・閾値は `tests/soak/thresholds.ts`（`parseSoakMode`）を単一の
情報源とする（unit test: `tests/soak/thresholds.test.ts`、`npm test` で検証）。長時間モードほど
許容増加率を厳しくする（微小なリークでも長時間では顕在化するため）。

`PLAYWRIGHT_BASE_URL` を指定すれば、他 E2E と同様にローカル本番ビルドではなく稼働中の任意
URL（実環境相当）へ向けられる。

### ハーネスの内容（`tests/e2e/soak/`）

- `soak-kiosk.spec.ts`: 待機 → 受付完走（`soak-driver.ts` の `runReceptionCycle`）を
  `SOAK_MODE` の総時間だけループし、次を定期サンプリング・判定する。
  - JS heap 使用量（`performance.memory`。Chromium 限定、非対応環境では判定をスキップ）
  - DOM ノード数（デタッチノード堆積の検知）
  - heartbeat 疎通（`/api/kiosk/heartbeat` を直接ポーリングし、最大欠落間隔を計測）
  - console エラー / 未捕捉例外（1 件でも FAIL）
  - 一定サイクルごとにネットワーク断→復帰（`context.setOffline`）・タブ非表示→復帰
    （`visibilitychange` 疑似発火）を注入し、自動復旧 (#30) の劣化（白画面・操作不能化）を検出
- `soak-time-boundaries.spec.ts`: 既存の `?inactivityMs=` 短縮フラグと Playwright の
  Clock API（`page.clock`）を組み合わせ、「無操作リセットの延長（セッション更新）」
  「無操作タイムアウト境界（閾値直前/直後）」「connected 状態の無操作境界 (#324)」
  「日付跨ぎ後も受付が完走すること」を実時間を待たず決定的に検証する。

### 判定基準（FAIL 条件）

`tests/soak/thresholds.ts` の `evaluateSoakRun` が判定する。いずれか 1 つでも該当すれば FAIL。

| 指標 | 既定閾値（モード別に `parseSoakMode` で変動） | 備考 |
| --- | --- | --- |
| console エラー / 未捕捉例外 | 0 件 | 1 件でも FAIL |
| JS heap 使用量増加率 | smoke 80% / 30m 50% / 2h 35% / 8h 25% | 起動直後のウォームアップ 1 サンプルは除外してから先頭比で算出 |
| DOM ノード数増加率 | heap と同じ既定値（`maxDomNodeGrowthPercent` で個別上書き可） | デタッチノード堆積の代理指標 |
| heartbeat 最大欠落間隔 | 90,000ms（heartbeat 間隔 30s の 3 倍） | 直近成功時刻からの経過で計測。一度も成功しなければ即 FAIL |
| ネットワーク断/タブ非表示からの復帰 | 復帰後に待機画面（`start-reception`）が表示されること | 白画面・操作不能化を検知（#30） |

### 実行結果・既知の制約

- ローカル/dev URL に対して実行でき、閾値超過時は非 0 終了（FAIL）する（soak-kiosk.spec.ts /
  soak-time-boundaries.spec.ts とも `smoke` モードで実行確認済み）。
- charter の「1 営業日連続稼働」を CI/ローカルの自動テストだけで毎回検証するのは非現実的
  （8h モードでも実行時間そのものが長大）。そのため **8h モードは opt-in**とし、実運用での
  「1 営業日連続稼働」は §「iPad 実機 soak チェックリスト」（`docs/ipad-uat.md`）で担保する
  （#65 スタック方針）。
- `performance.memory` は Chromium 限定・非標準 API。webkit 等では heap 判定はスキップされ
  （`heapGrowthPercent: null`）、DOM ノード数・heartbeat・console エラーの判定は継続する。

## 関連

- a11y E2E: `tests/e2e/a11y.spec.ts`（#7 / #125）
- 受付安全性・プライバシー E2E: `tests/e2e/kiosk-privacy.spec.ts`（#125）
- soak（1 営業日連続稼働）E2E: `tests/e2e/soak/`・純ロジック `tests/soak/thresholds.ts`（#317）
- セキュリティ・テスト方針: `docs/security-testing-plan.md` / `docs/security-checklist.md`（#6）
- 定期実行の記録: `docs/gate-runs.md`、記録ヘルパ: `scripts/record-gate-run.sh`（#318）
