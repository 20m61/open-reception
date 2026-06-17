# Security and Testing Plan: open-reception

## 1. 方針

open-reception は受付端末として来訪者が直接触るシステムであり、公開端末・個人情報・通話・通知を扱う。
そのため、実装初期からセキュリティ要件と自動テストを開発フローに組み込む。

## 2. 参照基準

- OWASP ASVS 5.0.0 をアプリケーションセキュリティ要件の参照軸にする
- OWASP Top 10 をリスク整理の入口にする
- Semgrep を SAST / secure coding guardrail として導入する
- 依存関係監査、Secret scan、lint、unit、e2e、アクセシビリティテストを CI に組み込む

## 3. セキュリティ要件

### 3.1 認証・認可

- 管理画面は認証必須
- iPad 受付端末は端末単位の kiosk token または device registration を使う
- 管理者 API と kiosk API を分離する
- 担当者情報の編集は管理権限のみ許可する
- 受付端末から管理 API を呼べないようにする

### 3.2 秘密情報管理

- Vonage API key/secret/private key はサーバー側のみで管理する
- フロントエンドに secret を含めない
- GitHub Secrets / cloud secrets manager を使う
- `.env` はコミット禁止
- CI で secret scan を実行する

### 3.3 入力検証

- 来訪者名、会社名、要件、検索語、音声認識結果はすべて検証する
- HTML として描画しない
- ログに保存する値は個人情報と制御文字を考慮する
- API は schema validation を行う

### 3.4 XSS/CSRF/CORS

- React のエスケープを前提にしつつ、危険な HTML 挿入を禁止する
- 管理画面は CSRF 対策を行う
- CORS は許可 origin を限定する
- CSP を設定し、外部 script/style/media の許可を管理する

### 3.5 通話・通知

- Vonage session/token は短命にする
- 来訪者が任意の担当者 ID やセッション ID を推測してアクセスできないようにする
- 通話開始、終了、失敗、拒否、タイムアウトを監査ログ化する
- 通話録音/録画は初期スコープ外。導入時は同意 UI と保存期間が必須

### 3.6 プライバシー

- 保存する来訪者情報を最小化する
- 保存期間を設定する
- 受付完了後、iPad 画面から個人情報を消す
- 障害ログに個人情報を過剰に含めない

### 3.7 iPad/kiosk 固有

- 端末ごとの識別子を払い出す
- 端末紛失時に kiosk token を失効できる
- 端末設定は管理画面から無効化できる
- 権限拒否、通信断、スリープ復帰を検知する

## 4. 自動テスト方針

### 4.1 Unit Test

対象:

- 状態遷移
- 入力バリデーション
- 担当者検索
- 呼び出し先選択
- エラー分類
- API schema

### 4.2 Component Test

対象:

- 待機画面
- 担当者/部署選択
- 入力フォーム
- 呼び出し中画面
- 失敗/代替導線
- VRM fallback 表示

### 4.3 E2E Test

Playwright で以下を検証する。

- 担当者呼び出しフローが完走する
- 部署呼び出しフローが完走する
- 音声認識不可でもタッチ操作で完走する
- Vonage mock 成功/失敗/タイムアウトで画面が分岐する
- 受付完了後に待機画面へ戻る
- iPad viewport でレイアウト崩れがない

### 4.4 Accessibility Test

- axe による基本チェック
- タッチターゲットの大きさ
- コントラスト
- 音声なしでも理解できる UI

### 4.5 Visual Regression

- 待機画面
- 担当者選択
- 呼び出し中
- 通話中
- エラー/代替導線
- iPad 横向き/縦向き viewport

### 4.6 Security Test

- Semgrep SAST
- npm/pnpm audit または依存関係監査
- secret scan
- API schema fuzz/invalid input test
- 認可テスト
- CORS/CSP 設定確認

## 5. CI 品質ゲート案

Pull Request で必須:

- install/build
- typecheck
- lint
- unit test
- e2e smoke test
- Semgrep
- dependency audit
- secret scan

main へのマージ前に推奨:

- full e2e
- visual regression
- accessibility test
- iPad 実機 UAT チェックリスト確認

## 6. GitHub Actions 初期案

```yaml
name: quality-gate

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  app-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck --if-present
      - run: npm run lint --if-present
      - run: npm test --if-present
      - run: npm run test:e2e --if-present

  semgrep:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep
    steps:
      - uses: actions/checkout@v4
      - run: semgrep scan --config auto --sarif --output semgrep.sarif || true
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: semgrep.sarif
```

## 7. iPad 実機 UAT チェックリスト

- Safari で待機画面を開ける
- ホーム画面追加/PWA 表示で使える
- ガイドアクセスまたはキオスク相当で固定できる
- 横向き表示で崩れない
- 縦向き表示でも最低限使える
- マイク拒否時にタッチ UI へ戻れる
- カメラ拒否時に代替導線が出る
- スリープ復帰後に操作できる
- 通信断から復帰できる
- 受付完了後に個人情報が残らない
