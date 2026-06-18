# AWS サーバーレス デプロイ手順（Next.js / OpenNext + CDK）

open-reception の Next.js アプリ本体を **AWS サーバーレス**（CloudFront + Lambda + S3）へ
デプロイする手順。インフラは AWS CDK (TypeScript) で定義する（`infra/`）。
通知サブシステム（#32/#34）の CDK 方針と同じ App に同居させる前提。

## アーキテクチャ

```
                ┌──────────────── CloudFront ────────────────┐
利用者(iPad) ──▶│  *               → server Lambda (SSR/API)  │
                │  /_next/image*   → image  Lambda (最適化)   │
                │  /_next/* ,      → S3 (静的アセット)         │
                │  /BUILD_ID                                   │
                └──────────────────────────────────────────────┘
   - server / image Lambda は Function URL(AWS_IAM) + CloudFront OAC で限定公開
   - proxy(旧 middleware) による /admin 認可は server Lambda 内で動作（nodejs runtime）
   - ISR/revalidate 不使用のため SQS/DynamoDB は無し（open-next.config.ts で dummy 化）
```

OpenNext が `.open-next/` に生成する成果物を、CDK の `WebStack` が取り込む。
出力契約（origins / behaviors）は `.open-next/open-next.output.json` を参照。

## 前提

- Node.js 22 以上
- AWS アカウントと認証情報（`aws configure` 済み、または環境変数）
- リージョン: 既定 `ap-northeast-1`（`CDK_DEFAULT_REGION` で変更可）
- 初回のみ CDK ブートストラップ済みであること

## 手順

### 1. アプリのビルド成果物を生成（OpenNext）

リポジトリルートで:

```bash
npm install
npm run verify          # typecheck / lint / test / build（品質ゲート）
npm run build:open-next # → .open-next/ を生成（内部で next build も実行）
```

### 2. インフラ依存をインストール

```bash
cd infra
npm install
```

### 3. CDK ブートストラップ（アカウント/リージョンごとに初回のみ）

```bash
cd infra
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=ap-northeast-1
npx cdk bootstrap
```

### 4. 合成して差分を確認

```bash
cd infra
npm run synth                 # env=dev（既定）
npx cdk synth -c env=prod     # 本番設定で合成
npx cdk diff  -c env=prod     # 既存スタックとの差分
```

### 5. アプリ環境変数（機密）の注入

server Lambda にはデプロイ時に環境変数を渡す。`.env.example` の server-only 値が対象。

- **非機密**（例 `ADMIN_AUTH_PROVIDER=none`）は context で渡せる:

  ```bash
  npx cdk deploy -c env=prod -c appEnv.ADMIN_AUTH_PROVIDER=none
  ```

- **機密**（`ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` / `KIOSK_SESSION_SECRET` /
  `ENTRA_*` / `VONAGE_*`）は平文でコミット・履歴に残さないこと。次のいずれかを推奨:
  - AWS Secrets Manager / SSM Parameter Store に保存し、デプロイ運用者がデプロイ時に
    `-c appEnv.KEY=...` へ展開する（CI のシークレットストアから注入）。
  - 値を runtime で取得する場合は server Lambda に Secrets Manager 読取権限を付与する
    follow-up を別途実装（現状の WebStack は環境変数注入方式）。

> `NODE_ENV=production` は WebStack が自動設定する。`ADMIN_AUTH_REQUIRED=false` は本番では
> アプリの fail-closed ガードによりエラーになる（#70）。

### 6. デプロイ

```bash
cd infra
npx cdk deploy OpenReception-Web-prod -c env=prod \
  -c appEnv.ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -c appEnv.ADMIN_SESSION_SECRET="$ADMIN_SESSION_SECRET" \
  -c appEnv.KIOSK_SESSION_SECRET="$KIOSK_SESSION_SECRET"
```

完了後、出力（Outputs）に表示される:
- `DistributionDomainName` … 公開 URL（`https://<domain>/kiosk`, `/admin`）
- `DistributionId` … キャッシュ無効化に使用
- `AssetBucketName` … 静的アセットバケット

### 7. 再デプロイ（コード更新時）

```bash
# ルートで再ビルド
npm run build:open-next
# infra で再デプロイ（アセットは BucketDeployment が更新）
cd infra && npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv.<...>
```

静的アセットは immutable（ハッシュ付き）。動的レスポンスは CloudFront でキャッシュ無効
（`CACHING_DISABLED`）のため、ページ更新の即時反映に手動 invalidation は不要。

## 環境別設定

`infra/lib/config/environments.ts` で dev / staging / prod を型付き定義。
Lambda メモリ・ログ保持・CloudFront PriceClass を環境ごとに調整する。
`-c env=<name>` で選択（既定 dev）。

## コスト管理タグ

`Project` / `Environment` / `Component` / `Owner` / `ManagedBy` を全リソースに付与
（`infra/lib/constructs/cost-tags.ts`、[cost-management-tags.md](./cost-management-tags.md)）。

## セキュリティ要点

- Lambda Function URL は `AWS_IAM` 認証 + CloudFront OAC（SourceArn 限定）で、直接の
  公開アクセス不可。CloudFront 経由のみ。
- S3 バケットは公開ブロック + OAC 経由のみ読取。`enforceSSL`。
- セキュリティヘッダ: アプリ側 `next.config.ts`（CSP 等）に加え、CloudFront でも
  `SECURITY_HEADERS` レスポンスポリシーを付与。
- 管理認可（`/admin`, `/api/admin`）は server Lambda 上の `proxy`（旧 middleware）が担う。

## 通知サブシステム（NotificationStack / MonitoringStack）

通知サブシステム（#32/#34）も同じ CDK App に含まれる。Next.js 本体（WebStack）とは
独立してデプロイできる。

```
拠点(受付/管理) → API Gateway(HTTP API) → 通知 Lambda → Polly(音声化) → Vonage(外部通知)
                       └ 拠点 authorizer(短命トークン HMAC 検証)    └ CloudWatch(構造化ログ)
```

- **NotificationStack**: HTTP API（`POST /notify`）+ 通知 Lambda + 拠点 authorizer Lambda +
  LogGroup。Lambda は VPC 外配置で NAT 固定費を回避。SSM 読取は拠点設定 prefix に限定、
  Polly は `pollyEnabled` 時のみ付与（最小権限）。
- **MonitoringStack**: Lambda エラー/遅延 p95/スロットル・API 5xx のアラームを SNS 通知、
  ダッシュボードを生成。

Lambda コードは `src/server/notification/`（handler / authorizer / adapters）を esbuild で
バンドルする。AWS SDK v3 は Lambda ランタイム同梱のため externalize。

### デプロイ

```bash
cd infra
# 拠点トークン鍵 Secret は必須（未指定だと authorizer が全拒否＝/notify が全て 401/403）
npx cdk deploy OpenReception-Notification-prod OpenReception-Monitoring-prod -c env=prod \
  -c siteTokenSecretName=open-reception/prod/site-token \  # 拠点トークン HMAC 鍵（必須）
  -c vonageSecretName=open-reception/prod/vonage \         # 任意: Vonage 接続情報
  -c alarmEmail=ops@example.com                            # 任意: アラーム通知先
```

### デプロイ前に用意するもの

- **拠点設定**: SSM Parameter Store に `<siteConfigPrefix>/<siteId>`（例
  `/open-reception/prod/sites/site-001`）で JSON を登録（`{ "enabled": true,
  "defaultTarget": {...}, "voice": {...} }`）。未登録/`enabled:false` の拠点は 403。
  siteId は英数字・`-`・`_` のみ（パラメータ名インジェクション防止のため allowlist 済み）。
- **拠点トークン鍵**: Secrets Manager に HMAC 鍵を保存し `-c siteTokenSecretName=...` で参照。
  authorizer が `SITE_TOKEN_SECRET_ARN` から runtime 取得（読取権限は CDK が付与）。未指定時は
  fail-closed で全拒否。拠点には `<siteId>.<exp>.<HMAC-SHA256(hex)>` 形式の短命トークンを配布。
  通知 API は authorizer の siteId と body の siteId が一致しない要求を 403（なりすまし防止）。
- **Vonage 実通知**（任意）: 通知 Lambda に `VONAGE_NOTIFY_ENDPOINT` と `VONAGE_NOTIFY_TOKEN`
  を与えると HttpVonageAdapter で実 HTTP 通知する（両方欠ける場合は Mock）。`-c vonageSecretName`
  で Secret 読取権限を付与でき、Vonage 固有の JWT 署名連携は follow-up。
- **アラーム通知先**: `-c alarmEmail=...` で SNS Email 購読を作成（未指定なら購読者なし）。

> 既定（dev / Secret 未指定）では Polly・Vonage とも mock で動作し、実発信・実音声化を
> 行わずに API フローを検証できる（ただし siteTokenSecret 未指定だと authorizer は全拒否）。

## クリーンアップ

```bash
cd infra && npx cdk destroy OpenReception-Web-dev -c env=dev
cd infra && npx cdk destroy OpenReception-Monitoring-dev OpenReception-Notification-dev -c env=dev
```

> prod の S3 バケットは `RemovalPolicy.RETAIN`。destroy 後も残るため手動削除する。
