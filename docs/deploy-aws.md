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
   - ISR/revalidate 用の SQS/DynamoDB は無し（open-next.config.ts で dummy 化）
   - 業務データ（部署/担当者/受付/履歴/設定）は DynamoDB シングルテーブルに永続化
     （server Lambda が読み書き。docs/persistence-design.md）
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

> **重要**: `appEnv` は **JSON オブジェクト文字列**として 1 つの context キーで渡す
> （`-c appEnv='{"KEY":"VALUE",...}'`）。`-c appEnv.KEY=VALUE` のドット記法は flat キー
> `"appEnv.KEY"` になり `bin/open-reception.ts` の `tryGetContext('appEnv')` で拾えないため
> **注入されない**（過去にこの誤りで secret 未注入 → 本番 fail-closed になった）。bin は
> 文字列なら `JSON.parse` する。

- **非機密**（例 `ADMIN_AUTH_PROVIDER=none`）も同じ JSON で渡す:

  ```bash
  npx cdk deploy -c env=prod -c appEnv='{"ADMIN_AUTH_PROVIDER":"none"}'
  ```

- **機密**（`ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` / `KIOSK_SESSION_SECRET` /
  `KIOSK_ENROLLMENT_SECRET` / `ENTRA_*` / `VONAGE_*`）は平文でコミット・履歴に残さないこと。
  次の **方式 B（推奨）** か方式 A を使う。
  > **注意**: `KIOSK_ENROLLMENT_SECRET`（受付URL/QR の署名鍵）は実デプロイ（Lambda）で**必須**。
  > 未設定だと未認証 `/api/kiosk/enroll` が fail-closed で 500 になり、発行/エンロールが機能しない
  > （`docs/reception-issuance-design.md`）。Secrets/appEnv の JSON に必ず含める。

#### 方式 A: appEnv 平文注入（従来）

AWS Secrets Manager / SSM に保存した値を、デプロイ運用者がデプロイ時に `-c appEnv='{...}'`
へ展開する（CI のシークレットストアから注入）。Lambda 環境変数に平文で乗る点に注意。

#### 方式 B: Secrets Manager から runtime 取得（推奨） (issue #194)

機密を 1 つの Secrets Manager シークレット（**JSON オブジェクト**）にまとめ、`appSecretsName`
を渡す。WebStack が server Lambda に `secretsmanager:GetSecretValue` を付与し `APP_SECRETS_ARN`
を設定、Lambda 起動時に `src/instrumentation.ts` の `register()` が JSON を解決して
`process.env` へ流し込む（既存の同期 getter は無改変）。Lambda 環境変数に機密の平文が乗らない。

```bash
# 1) シークレットを作成（JSON オブジェクト。キーは env 名に一致させる）
aws secretsmanager create-secret --name open-reception/prod/app \
  --secret-string '{"ADMIN_PASSWORD":"...","ADMIN_SESSION_SECRET":"...","KIOSK_SESSION_SECRET":"..."}'

# 2) デプロイ時に名前を渡す（appEnv には非機密のみ）
npx cdk deploy OpenReception-Web-prod -c env=prod \
  -c appEnv='{"ADMIN_AUTH_PROVIDER":"none"}' \
  -c appSecretsName=open-reception/prod/app
```

- `appSecretsName` 未指定なら方式 A のまま（**後方互換**）。
- 明示注入（`appEnv`）が同名キーを持つ場合はそちらを優先（register は既存キーを上書きしない）。
- シークレット取得失敗時は Lambda 起動が **fail-fast**（dev 既定値での稼働を防ぐ）。

> `NODE_ENV=production` は WebStack が自動設定する。`ADMIN_AUTH_REQUIRED=false` は本番では
> アプリの fail-closed ガードによりエラーになる（#70）。

#### 機能させるための必須コンテキスト（dev/prod 共通・2026-06-30 検証で確定）

CloudFront 越しに **POST/フォーム/受付発行が機能する**ために、次の 2 つは実質必須:

1. **`-c originVerifySecret=<高エントロピー値>`**: 未指定だと Function URL=AWS_IAM+OAC のままで、
   CloudFront OAC が **POST ボディを署名しないため全 POST が 403**（login / 受付URL発行 /
   `/api/kiosk/enroll` が動かない）。指定すると Function URL=NONE + CloudFront `x-origin-verify`
   秘密ヘッダ方式に切替わり、`proxy.ts` が照合する（直叩きは 403）。
2. **`appEnv` に公開オリジン**: `NEXT_PUBLIC_APP_URL` と `RESERVATION_CHECKIN_BASE_URL` を
   **公開 CloudFront ドメイン（またはカスタムドメイン）**に設定する。未設定だと
   `resolveCheckinBaseUrl` がリクエスト host にフォールバックし、発行する受付URL/予約QRの host が
   **内部 Lambda Function URL（…lambda-url…on.aws）**になり、配布した QR を開くと 403 になる。

> 機密 `KIOSK_ENROLLMENT_SECRET`（受付URL署名鍵）も忘れず secret JSON に含める（手順 5 参照。
> 未設定だと未認証 `/api/kiosk/enroll` が fail-closed で 500）。

### 6. デプロイ

```bash
cd infra
# 機密値を JSON にまとめて 1 つの appEnv context で渡す（jq でエスケープすると安全）。
APP_ENV=$(jq -nc \
  --arg p "$ADMIN_PASSWORD" --arg a "$ADMIN_SESSION_SECRET" --arg k "$KIOSK_SESSION_SECRET" \
  '{ADMIN_PASSWORD:$p, ADMIN_SESSION_SECRET:$a, KIOSK_SESSION_SECRET:$k}')
npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv="$APP_ENV"
```

完了後、出力（Outputs）に表示される:
- `DistributionDomainName` … 公開 URL（`https://<domain>/kiosk`, `/admin`）
- `DistributionId` … キャッシュ無効化に使用
- `AssetBucketName` … 静的アセットバケット
- `DataTableName` … 業務データ DynamoDB テーブル名（seed/運用に使用）

> `DATA_BACKEND=dynamodb` と `TABLE_NAME` は WebStack が server Lambda に自動設定する
> （`-c appEnv` での指定は不要）。テーブルへの読み書き権限も付与済み。

### 7. 初期データ投入（seed・初回のみ）

DynamoDB は seed を自動投入しない（運用データ保護のため）。初回は最小データを投入する:

```bash
# ルートで（DataTableName は手順6の Outputs）
DATA_BACKEND=dynamodb TABLE_NAME=<DataTableName> AWS_REGION=ap-northeast-1 \
  npm run seed:dynamodb              # 端末1台 + 既定背景アセット + 既定 tenant/site/device
# デモ用に架空の部署・担当者も入れる場合:
#   npm run seed:dynamodb -- --with-mock
```

部署・担当者は管理画面（`/admin`）や CSV インポートからも登録できる。
seed は冪等（同一 id は上書き）。

### 8. 再デプロイ（コード更新時）

```bash
# ルートで再ビルド
npm run build:open-next
# infra で再デプロイ（アセットは BucketDeployment が更新）
cd infra && npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv.<...>
```

静的アセットは immutable（ハッシュ付き）。動的レスポンスは CloudFront でキャッシュ無効
（`CACHING_DISABLED`）のため、ページ更新の即時反映に手動 invalidation は不要。

## カスタムドメイン（既存サブドメインの紐付け・任意） (issue #189)

DNS 委譲・サブドメイン作成が**別管理で完了済み**の既存 FQDN を CloudFront に紐付ける。
`-c customDomain='{...}'`（JSON 文字列）を WebStack に渡す。`enabled:false` または未指定なら
CDK 生成ドメインのみ。

> **重要**: CloudFront は **us-east-1 の ACM 証明書**しか受け付けない。証明書はこの Stack では
> 発行せず、`domainName`（と追加ドメイン）をカバーする**既存の us-east-1 証明書 ARN**を
> `certificateArn` に指定する（クロスリージョン発行は scope 外）。

| キー | 必須 | 説明 |
| --- | --- | --- |
| `domainName` | ✓ | Distribution に割り当てる FQDN（例: `open-reception.parent.example.com`） |
| `certificateArn` | ✓ | us-east-1 の ACM 証明書 ARN |
| `additionalDomainNames` | | 追加の代替ドメイン名 |
| `hostedZoneDomainName` | △ | Route53 管理ゾーンのドメイン（`createDnsRecord` 時のみ必須） |
| `createDnsRecord` | | `true` で alias A/AAAA を Route53 に作成（既定 `false`） |

```bash
# Route53 管理下: alias A/AAAA も自動作成
npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv="$APP_ENV" \
  -c customDomain='{"domainName":"open-reception.parent.example.com",
  "certificateArn":"arn:aws:acm:us-east-1:<acct>:certificate/<id>",
  "hostedZoneDomainName":"parent.example.com","createDnsRecord":true}'

# Route53 管理外/手動管理: CloudFront 紐付けのみ（DNS は別途 CNAME/ALIAS を手動設定）
npx cdk deploy OpenReception-Web-prod -c env=prod -c appEnv="$APP_ENV" \
  -c customDomain='{"domainName":"open-reception.parent.example.com",
  "certificateArn":"arn:aws:acm:us-east-1:<acct>:certificate/<id>","createDnsRecord":false}'
```

紐付け後、Outputs の `CustomDomainUrl` が公開 URL になる。`createDnsRecord:false` の場合は
DNS 側で当該 FQDN を `DistributionDomainName` 宛の CNAME/ALIAS に向ける。

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

## WebStack の監視（WebMonitoringStack） (issue #299)

本番トラフィックの主経路である WebStack を監視する専用 Stack。WebStack と同時に
（`--all` またはスタック名指定で）デプロイする。

```bash
cd infra
npx cdk deploy OpenReception-Web-prod OpenReception-WebMonitoring-prod -c env=prod \
  -c appEnv="$APP_ENV" \
  -c alarmEmail=ops@example.com   # 任意: アラーム通知先（下記参照）
```

- **アラーム（8 個、5 分 period / missing data は notBreaching）**:
  - server Lambda: Errors / Throttles / Duration p95（タイムアウトの 80% 超・3 期間）/
    ConcurrentExecutions（アカウント既定上限 1000 の 80% = 800 到達で暴走/攻撃の兆候）
  - image Lambda: Errors / Duration p95
  - DynamoDB: ThrottledRequests（read 系 / write 系オペレーション別。オンデマンドでも
    テーブル/パーティション上限超過でスロットルは起こり得る）
- **ダッシュボード** `open-reception-<env>-web`: Lambda invocations/errors/duration p95、
  DynamoDB Consumed RCU/WCU + Throttles、CloudFront Requests / BytesDownloaded / 5xxErrorRate。
- **SNS Topic は MonitoringStack と分離**（cost tag `Component=web` / デプロイ独立性のため）。
  `-c alarmEmail` は両 Stack の Topic に同じ値が購読されるため運用上の差はない。

> **CloudFront 5xxErrorRate の「アラーム」は未提供（意図的な見送り）**: AWS/CloudFront
> メトリクスは **us-east-1 にのみ発行**され、CloudWatch アラームはメトリクスと同一リージョン
> にしか置けない。us-east-1 の別 Stack + `crossRegionReferences`（custom resource 追加）は
> 複雑さに見合わないため、リージョン跨ぎ参照が可能なダッシュボード widget でカバーする。
> オリジン起因の 5xx は server/image Lambda の Errors アラームで実質検知できる。

### alarmEmail の運用

- 通知先メールは **`-c alarmEmail=ops@example.com`** をデプロイコマンドで都度渡す
  （WebMonitoringStack / MonitoringStack 共通）。未指定なら Topic は作られるが購読者なし
  （= 発報しても届かない）ので、実運用環境では必ず指定する。
- `infra/lib/config/environments.ts` の `alarmEmail` 既定は全環境で空にしてある。実メール
  アドレスのコード埋め込みは平文コミット（公開リポジトリでのアドレス収集・spam 対象化）に
  なるため行わない。
- 初回デプロイ後、SNS からの確認メール（Subscription Confirmation）を承認するまで通知は
  届かない。

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
- **Vonage 実通知**（任意）: 次のいずれかで HttpVonageAdapter による実 HTTP 通知が有効化される
  （どちらも無ければ Mock）。
  1. `-c vonageSecretName=...` で Secrets Manager に JSON `{ "endpoint": "...", "token": "..." }`
     を保存。handler が初回 notify 時に Secret を解決（読取権限は CDK が付与）。
  2. 通知 Lambda に `VONAGE_NOTIFY_ENDPOINT` と `VONAGE_NOTIFY_TOKEN` を直接 env 指定。
  Vonage 固有の JWT 署名連携は follow-up。
- **アラーム通知先**: `-c alarmEmail=...` で SNS Email 購読を作成（未指定なら購読者なし）。
  同じ context が WebMonitoringStack の Topic にも適用される（「alarmEmail の運用」参照）。

> 既定（dev / Secret 未指定）では Polly・Vonage とも mock で動作し、実発信・実音声化を
> 行わずに API フローを検証できる（ただし siteTokenSecret 未指定だと authorizer は全拒否）。

## クリーンアップ

```bash
cd infra && npx cdk destroy OpenReception-WebMonitoring-dev OpenReception-Web-dev -c env=dev
cd infra && npx cdk destroy OpenReception-Monitoring-dev OpenReception-Notification-dev -c env=dev
```

> prod の S3 バケットは `RemovalPolicy.RETAIN`。destroy 後も残るため手動削除する。
