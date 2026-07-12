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

## 関連

- a11y E2E: `tests/e2e/a11y.spec.ts`（#7 / #125）
- 受付安全性・プライバシー E2E: `tests/e2e/kiosk-privacy.spec.ts`（#125）
- セキュリティ・テスト方針: `docs/security-testing-plan.md` / `docs/security-checklist.md`（#6）
- 定期実行の記録: `docs/gate-runs.md`、記録ヘルパ: `scripts/record-gate-run.sh`（#318）
