# open-reception

open-reception は、iPad を受付端末として利用する無人受付システムです。
来訪者がタッチ画面・音声認識・音声合成・VRM アバターを通じて受付操作を行い、担当者を Vonage などのリアルタイム通信基盤で呼び出します。

## 目的

- 来訪者が迷わず担当者を呼び出せる受付体験を提供する
- 担当者が外出中・在席中を問わず、適切に来訪を把握し応対できるようにする
- iPad を専用受付端末として安全・安定運用できるようにする
- VRM アバターと音声 UI により、無人でも冷たくない案内体験を作る

## 想定利用環境

- 受付端末: iPad / iPadOS / Safari または PWA
- 入力: タッチ操作、音声認識
- 出力: 画面表示、音声合成、VRM アバターの表情・モーション
- 通信: Vonage Video API / WebRTC 相当のリアルタイム通話
- 管理: 担当者、部署、呼び出し先、受付履歴、端末設定

## ローカル起動手順

前提: Node.js 22 以上。

```bash
npm install
npm run dev            # http://localhost:3000 で起動
```

- 受付端末: http://localhost:3000/kiosk
- 管理画面: http://localhost:3000/admin

### 受付 MVP フロー（実装済み）

`/kiosk` で iPad 受付フローが動作します（状態遷移モデルで制御）。

待機 → 目的選択 → 担当者/部署選択（検索可） → 来訪者情報入力 → 確認 →
呼び出し中 → 成功 / 未応答 / 失敗（代替導線） → 完了（自動で待機画面へ復帰）

- 呼び出しは mock adapter で成功/未応答/失敗/タイムアウトを再現（本番 Vonage は adapter 差し替え）
- 受付セッションは mock backend（`/api/kiosk/receptions*`）で作成・更新
- 担当者/部署は仮データ（管理画面・CSV インポートで置換予定）
- 完了/キャンセル後は個人情報を画面に残さない

### 受付端末のアクセス制御（実装済み）

受付端末は PIN / IP 許可で初回許可でき（`/admin/security` で設定）、許可後は長期 kiosk セッションでリロード/再起動後も表示を維持します（`POST /api/kiosk/authorize`、`GET /api/kiosk/session-status`）。kiosk セッションでは管理画面/API を操作できません。PIN は既定で無効です。
`/admin/security` から **緊急停止モード**（確認付き）で全端末の受付を一括停止/再開できます。設定変更は監査ログに記録されます。

### 管理画面の認可（実装済み）

`/admin/*` と `/api/admin/*` は管理セッション必須です（middleware で保護）。未認証は `/admin/login` へリダイレクト、管理 API は 401 を返します。受付端末（kiosk）からは管理画面/API にアクセスできません。`/api/kiosk/*` は公開です。
ログインは `/admin/login`（パスワードは `ADMIN_PASSWORD`、署名は `ADMIN_SESSION_SECRET`。いずれも server-only）。

### 受付端末管理・失効（実装済み）

受付端末を `/admin/kiosks` で登録・失効・再有効化できます。受付端末は `GET /api/kiosk/config?kioskId=...` で設定を取得し、**失効端末は受付開始を停止**します（利用停止画面を表示）。

### 部署・担当者管理（実装済み）

部署・担当者を管理画面 `/admin/departments`・`/admin/staff` で作成・編集・有効/無効・並び替えできます。
受付端末は共有のディレクトリ API（`GET /api/kiosk/directory`）から取得するため、
管理画面の変更がコード修正なしで受付画面に反映されます。管理 API は `/api/admin/departments`・`/api/admin/staff`。
**CSV による一括登録/更新**にも対応（各管理画面の「CSV インポート」、`POST /api/admin/{departments,staff}/import` の preview/apply）。
（DnD 並び替え・担当者の不在/代替設定は後続 #25 #26。認証・認可は #24。）

### 受付履歴・監査ログ（実装済み）

呼び出し結果（応答/未応答/失敗/キャンセル）・所要時間・代替導線の利用を記録し、
管理画面 `/admin/receptions` で閲覧できます（`GET /api/admin/receptions`）。
来訪者の氏名・会社名・要件メモなどの個人情報はログに保持しません。方針は
[`docs/audit-logging.md`](./docs/audit-logging.md) を参照。

加えて、**管理操作（部署・担当者・端末の作成/更新/失効/並び替え）も監査ログに記録**され、
受付イベントとあわせて `/admin/audit`（`GET /api/admin/audit`）で確認できます。

### 開発コマンド

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | 開発サーバ起動 |
| `npm run build` | 本番ビルド |
| `npm run typecheck` | 型チェック (`tsc --noEmit`) |
| `npm run lint` | ESLint |
| `npm test` | ユニットテスト (Vitest) |
| `npm run test:e2e` | iPad viewport の E2E smoke test (Playwright) |
| `npm run verify` | typecheck → lint → test → build を一括実行（品質ゲート） |

> 本リポジトリは GitHub Actions を使用しません。コミット/PR 前に `npm run verify` をローカル実行して品質ゲートを通してください。E2E は別途 `npm run test:e2e` で実行します。

E2E を初めて実行する場合はブラウザを取得する。

```bash
npx playwright install --with-deps chromium webkit
```

ソース構成と認可境界の方針は [`src/ARCHITECTURE.md`](./src/ARCHITECTURE.md) を参照。

## 初期ドキュメント

- [Project Charter](./PROJECT_CHARTER.md)
- [Requirements](./docs/requirements.md)
- [Specification](./docs/specification.md)
- [Security and Testing Plan](./docs/security-testing-plan.md)
- [iPad 運用・実機 UAT チェックリスト](./docs/ipad-uat.md)
- [受付履歴・監査ログ方針](./docs/audit-logging.md)

## 品質方針

- 仕様は Issue と Pull Request に紐づける
- Semgrep / dependency audit / secret scan / lint / unit test / e2e test を段階的に導入する
- OWASP ASVS をセキュリティ要件の参照軸にする
- iPad 実機検証を受け入れ条件に含める
