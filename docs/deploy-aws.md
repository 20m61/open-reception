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

1. **origin-verify シークレット**: 未指定だと Function URL=AWS_IAM+OAC のままで、
   CloudFront OAC が **POST ボディを署名しないため全 POST が 403**（login / 受付URL発行 /
   `/api/kiosk/enroll` が動かない）。指定すると Function URL=NONE + CloudFront `x-origin-verify`
   秘密ヘッダ方式に切替わり、`proxy.ts` が照合する（直叩きは 403）。渡し方は 2 通りで、
   **prod では Secrets Manager 方式が必須**（下記「origin-verify シークレットの供給」）。
2. **`appEnv` に公開オリジン**: `NEXT_PUBLIC_APP_URL` と `RESERVATION_CHECKIN_BASE_URL` を
   **公開 CloudFront ドメイン（またはカスタムドメイン）**に設定する。未設定だと
   `resolveCheckinBaseUrl` がリクエスト host にフォールバックし、発行する受付URL/予約QRの host が
   **内部 Lambda Function URL（…lambda-url…on.aws）**になり、配布した QR を開くと 403 になる。

> 機密 `KIOSK_ENROLLMENT_SECRET`（受付URL署名鍵）も忘れず secret JSON に含める（手順 5 参照。
> 未設定だと未認証 `/api/kiosk/enroll` が fail-closed で 500）。

#### origin-verify シークレットの供給 (#612)

| | context | CFN テンプレート | Lambda 環境変数 | 使う環境 |
| --- | --- | --- | --- | --- |
| 生値 | `-c originVerifySecret=<値>` | **平文** | 解決済みの値 | **dev のみ** |
| Secrets Manager | `-c originVerifySecretName=<シークレット名>` | 動的参照 | 解決済みの値 | dev 以外は必須 |

Secrets Manager 方式では、シークレット JSON の **`ORIGIN_VERIFY_SECRET` キー**を参照する。
`appSecretsName` と同じシークレットで良い（手順 5 の JSON にキーを 1 つ足すだけ）。

- CloudFront の origin custom header と server Lambda の環境変数の**両方**に CFN 動的参照
  （`{{resolve:secretsmanager:<name>:SecretString:ORIGIN_VERIFY_SECRET::}}`）が入るため、
  **合成される CFN テンプレートに平文は載らない**。末尾の `::` は version-stage / version-id
  省略（= `AWSCURRENT`）で、CDK が実際に出力する形。
- **`cdk deploy` 実行ロールに `secretsmanager:GetSecretValue` が必要**（CFN が動的参照を
  解決するため）。無いと初回デプロイが不可解なエラーで落ちる。
- 両モードとも `ORIGIN_VERIFY_REQUIRED=1`（非機密）を渡す。**検証の ON/OFF はこのフラグだけが
  決める**（シークレットの有無では決めない）。これが立っていて値が未解決なら `proxy.ts` は
  **503 を返す**（`mismatch` の 403 とは別。前者は配備側の障害、後者は直叩き）。
- **dev 以外で `-c originVerifySecret=<生値>` を渡すと `cdk synth` が失敗する**（WebStack が拒否）。
  併用も、**空文字も**不可（`-c originVerifySecret=$UNSET_VAR` を黙って無効化に落とさないため）。
- `ORIGIN_VERIFY_*` を `appEnv` から渡すことはできない（synth で拒否）。「検証を要求するが値が無い」
  状態を手で作れてしまい、全リクエストが恒久 503 になるため。
- `ORIGIN_VERIFY_REQUIRED` で**偽になるのは `0` と空文字だけ**。`false` は真（曖昧な値は
  fail-closed 側へ倒す）。無効化するときは env ごと外すこと。

> **🔴 prod で有効化する前に必要なこと**
>
> - **dev で 1 度 Secrets Manager 方式をデプロイして live 検証する**（この方式は未実測。#65）。
>   確認する 3 点: (a) `aws cloudfront get-distribution-config` の `HeaderValue` が
>   `{{resolve:` で始まって**いない**（解決されずリテラルのまま送られていると、共有シークレットが
>   公開文字列になり防御がゼロになる）、(b) Function URL 直叩きが 403、(c) CloudFront 経由の
>   POST が 200。あわせて `curl -H 'x-origin-verify: junk' https://<cf-domain>/kiosk` が 200 に
>   なること（CloudFront が custom header を**置換**し追記でないこと）も見る。
> - ~~#630（403 のアラーム）を閉じる~~ … **解消済み**。`WebMonitoringStack` が拒否ログ由来の
>   `OriginVerifyMissingSecret` / `OriginVerifyMismatch` を監視する（上記「解消済み」節）。
>   ただし**アラームは `OpenReception-WebMonitoring-<env>` をデプロイして初めて効く**。
>   WebStack だけ入れて監視スタックを入れないと、検知経路は従来どおり「来訪者の申告」のまま。
> - **モード切替・値変更は受付停止時間帯に**。Lambda env と Distribution は原子的に更新されず、
>   Distribution の伝播に数分かかる。その間 `mismatch` で 403 になる。

> **なぜ Lambda 環境変数に値が入るのか（runtime 取得にしない理由）**
>
> middleware（`src/proxy.ts`）は OpenNext の routing 層から呼ばれ、**`src/instrumentation.ts` の
> `register()` より先に走る**。しかも middleware が拒否応答を返すと routing 層がその場で返し、
> Next サーバへ到達しないため `register()` が走らない。ARN を渡して起動時解決にすると、
> **コールドスタート直後の正当なリクエストが落ちる**。回復するのは matcher 除外パス
> （`/favicon.ico` 等）が同じインスタンスに当たったときだけで、**回復の有無がリクエスト順に
> 依存する断続障害**になる（#612 のレビューで判明）。よって値はプロセス開始時から
> 環境変数に在る必要がある。

**残る露出**: 解決後の値は CloudFront Distribution 設定（`cloudfront:GetDistribution*`）と
Lambda 環境変数（`lambda:GetFunctionConfiguration`）として保持される。CloudFront が origin へ
リテラル値を送る方式である以上、前者は避けられない。**このヘッダが守るのは「エッジを迂回されない」
ことだけ**で、管理は Cognito セッション、端末は kiosk セッションが別途認可する（#612 の判断記録）。

**適用範囲の穴（未修正）**:

- **403 / 503 に来訪者向けの画面が無い**（#629）。iPad に `forbidden` /
  `service unavailable` の素の文字列が出る。
**解消済み**:

- ~~403 の全断はアラームに引っかからない~~（#630 で解消）。middleware の応答は Lambda としては
  成功呼び出しなので `Errors` に出ず、CloudFront の 4xx アラームは**今も意図的に置いていない**
  （ボットのパス探索で恒常的に発生し、「直叩き」と「配備破損」を分離できないため）。代わりに
  **アプリの拒否ログをメトリクス化**して `WebMonitoringStack` にアラームを 2 本置いた:

  | メトリクス | しきい値 | 意味 |
  | --- | --- | --- |
  | `OriginVerifyMissingSecret` | **1 件 / 5 分** | 配備側の自損。全リクエストが 503。即対応 |
  | `OriginVerifyMismatch` | 10 件 / 5 分 × 3 | ローテーションずれの疑い。単発は直叩き＝正常動作 |

  検索文字列は `ORIGIN_VERIFY_LOG_MARKERS`（`src/lib/security/origin-verify.ts`）を
  **アプリと CDK で共有**する。ログ文言を書き換えるとアラームが黙って外れるため、
  定数を 1 箇所に置き、両側からの乖離をテストで固定してある。

  なお **503 は CloudFront の `5xxErrorRate` アラーム（#303・1%/15分）にも乗る**が、あちらは
  率なので低トラフィックの受付端末では分母が小さく暴れる。件数で見る本アラームと併用する。

> image 最適化 Function URL の無検証公開（#631）は**この PR で解消済み**。image は GET のみで
> OAC の POST 署名問題に当たらないため、origin-verify 方式でも常に OAC + `AWS_IAM` に据え置く。

**🔴 このシークレットをローテーションしないこと（#612 増分 2 まで手段が無い）。**

CFN が動的参照を再解決するのは「**その参照を含むリソースが更新対象になったとき**」だけ
（[AWS ドキュメント](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html)）。
CloudFront ヘッダと Lambda 環境変数はどちらも同じ文字列 `{{resolve:secretsmanager:...}}` なので、
Secrets Manager の値を差し替えてもテンプレートに差分は出ない。ここから **2 通りに転ぶ**:

| 状況 | 何が起きるか |
| --- | --- |
| 値だけ差し替えて `cdk deploy`（アプリ変更なし） | 差分ゼロ＝**何も更新されない**。403 も起きないので運用者は「ローテーション完了・旧鍵失効」と信じるが、**旧鍵が現役で有効**なまま |
| 値を差し替えた後にアプリ変更を伴う `cdk deploy` | server Lambda は code asset のハッシュが変わるので**更新対象になり、env が新しい値に再解決される**。一方 Distribution はプロパティ不変で**更新されない＝古い値を送り続ける** → **全リクエストが `mismatch` で 403。デプロイ完了後も回復しない** |

2 つ目が危険で、**アプリの通常デプロイが引き金になる**（ローテーションの直後とは限らない）。
来訪者に見えるのは `forbidden` の 1 語だけで（#629）、403 はアラームにも出ない（#630）。

手段を用意するには動的参照の文字列自体を可変にする必要がある（`versionId` を含める等）。
**未実装。**

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

## dev をゼロから立ち上げる手順（2026-08-04 実測）

**この節は実際に一度通した記録。** 抜けると必ず詰まる箇所が 4 つあり、いずれも
「デプロイは成功するのに使えない」形で現れる。

### 1. 成果物をビルドし直す

```sh
npm run build:open-next
```

`cdk deploy` は `.open-next/` を取り込むが、**これは `npm run build:open-next` を明示的に
叩いたときだけ更新される**。`.next` は品質ゲートの度に更新されるので、両者は気づかないうちに
乖離する。2026-08-04 に**11 日前の成果物を配り、セキュリティ修正 4 件が欠けた状態**で動いた。

現在は `WebStack.assertBuildArtifactsAreFresh()` が `src/` より古い成果物を止める（#611）。

### 2. アプリシークレットを Secrets Manager に置く

```sh
# ADMIN_SESSION_SECRET / KIOSK_SESSION_SECRET / KIOSK_ENROLLMENT_SECRET を含む JSON
aws secretsmanager create-secret --name open-reception/dev/app-v2 --secret-string file://secrets.json
```

未設定だと**端末エンロールが 500 で失敗する**。アプリが
「開発用の既定シークレットを deployed 環境で使うことを拒否」して安全側に倒れるため
（`src/lib/auth/kiosk-enrollment.ts`）。**これは正しい挙動**なので、シークレットを与える。

### 3. デプロイ（context 2 つが必須）

```sh
cd infra
npx cdk deploy OpenReception-Web-dev --require-approval never \
  -c originVerifySecret=<高エントロピー値> \
  -c appSecretsName=open-reception/dev/app-v2
```

**`originVerifySecret` を省くと POST が全滅する。** CloudFront OAC は Lambda Function URL への
リクエスト**ボディを署名しない**ため、Function URL の SigV4 検証が必ず失敗する
（GET は通り、POST/PUT/PATCH/DELETE だけ 403）。指定すると Function URL が `NONE` になり、
CloudFront が `x-origin-verify` を付与、`src/proxy.ts` が照合して直叩きを拒否する。

**prod では生値ではなく `-c originVerifySecretName=<シークレット名>`**（同じシークレットの
`ORIGIN_VERIFY_SECRET` キー）。生値は prod では `cdk synth` が拒否する。
詳細は上の「origin-verify シークレットの供給 (#612)」。

**どちらの context も次回デプロイで指定を忘れると壊れる。** 指定を省いた `cdk deploy` は
成功するが、POST が 403 に戻り、エンロールが 500 に戻る。

### 4. 管理者を作る

```sh
POOL=<AdminUserPoolId>   # スタック出力
aws cognito-idp create-group --user-pool-id $POOL --group-name Admin
aws cognito-idp admin-create-user --user-pool-id $POOL --username admin --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id $POOL --username admin --password <値> --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username admin --group-name Admin
```

グループ名は `Admin` / `SiteManager` / `Viewer`（または `OpenReception.` 接頭辞付き）。
`src/domain/auth/roles.ts` の `APP_ROLE_TO_ADMIN_ROLE` が真実源。

**Cognito ユーザーだけでは管理 API に入れない。** `resolveActorFromStore` が
AdminUser レコードの無い SSO ユーザーを既定で拒否するため（最小権限。設計として正しい）。
新規環境には AdminUser を作る経路が無い（#83 の JIT プロビジョニングが未配線）ので、
**dev のみ** `OPEN_RECEPTION_ENTRA_UNREGISTERED=env_roles` を CDK が設定する（#613）。

### 5. 端末をエンロールする

```sh
# 管理セッションで
POST /api/admin/kiosks                      {"displayName":"dev端末1"}
POST /api/admin/devices/<kioskId>/reissue-token   {"tenantId":"internal"}
#   → {"device":..., "enrollmentUrl":"https://.../kiosk/enroll?token=...", "expiresAt":...}
```

**トークンは 15 分で失効し、単回使用。** iPad で開く直前に発行する。
エンロール URL を開くと `kiosk_session` cookie が付き、受付画面が使えるようになる。

未エンロールの端末は「受付端末の設定が必要です」で止まる（#239 のセッションゲート。正しい挙動）。

### 6. 初期データ

新規 DynamoDB は空。`/api/admin/departments` と `/api/admin/staff` で部署・担当者を作る。
作らないと受付端末に呼び出す相手が居ない。

### 通し確認（2026-08-04 実測）

管理画面で公開表示名を変更し、担当者に兼務を設定した結果が、来訪者向けの実効構成へ届く:

```
部署: ['営業（お客さま窓口）', '技術部', '総務部']
担当者: 鈴木 花子 / affiliation: {primary: '営業（お客さま窓口）', secondary: ['技術部']}
```

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

- **アラーム（11 個、5 分 period / missing data は notBreaching）**:
  - server Lambda: Errors / Throttles / Duration p95（タイムアウトの 80% 超・3 期間）/
    ConcurrentExecutions（アカウント既定上限 1000 の 80% = 800 到達で暴走/攻撃の兆候）
  - Lambda リージョン全体: ConcurrentExecutions（次元なし、同じく 800 到達）。上限 1000 は
    アカウント × リージョン共有のため、per-function だけでは合計での枯渇を過小検知する (#303)
  - image Lambda: Errors / Duration p95
  - origin-verify (#630): `OriginVerifyMissingSecret`（1 件で即）/ `OriginVerifyMismatch`
    （10 件 × 3 期間）。ログ由来のメトリクスフィルタで、middleware の 403/503 を拾う
  - DynamoDB: ThrottledRequests（read 系 / write 系オペレーション別。オンデマンドでも
    テーブル/パーティション上限超過でスロットルは起こり得る）
- **ダッシュボード** `open-reception-<env>-web`: Lambda invocations/errors/duration p95、
  DynamoDB Consumed RCU/WCU + Throttles、CloudFront Requests / BytesDownloaded / 5xxErrorRate。
- **SNS Topic は MonitoringStack と分離**（cost tag `Component=web` / デプロイ独立性のため）。
  `-c alarmEmail` は両 Stack の Topic に同じ値が購読されるため運用上の差はない。

> **CloudFront 5xxErrorRate の「アラーム」はこの Stack にはない**: AWS/CloudFront メトリクスは
> **us-east-1 にのみ発行**され、CloudWatch アラームはメトリクスと同一リージョンにしか
> 置けない。この Stack ではリージョン跨ぎ参照が可能なダッシュボード widget でのみカバーし、
> アラームは us-east-1 の CloudFrontMonitoringStack（次節、#303）が持つ。

## CloudFront の監視（CloudFrontMonitoringStack, us-east-1） (issue #303)

CloudFront `5xxErrorRate`（Average が 1% を 3 × 5 分 = 15 分継続で発報、missing data は
notBreaching）のアラームを **us-east-1** に置く小さな Stack。SNS Topic も us-east-1 に別途
作成し、`-c alarmEmail` で購読する（アラームアクションの Topic はアラームと同一リージョン
である必要があるため）。

```bash
cd infra
npx cdk deploy OpenReception-CfMonitoring-prod -c env=prod \
  -c appEnv="$APP_ENV" \
  -c alarmEmail=ops@example.com   # 任意: アラーム通知先
```

- **DistributionId の連携は `crossRegionReferences`**（WebStack と本 Stack の双方に設定済み）。
  CloudFormation Export ではなく **SSM Parameter 経由の custom resource**（WebStack 側に
  ExportWriter、本 Stack 側に ExportReader）で連携されるため、既存 WebStack には writer
  リソースが追加されるだけで既存リソースの変更・置換はない。
- 初回は WebStack 側に ExportWriter が追加されるため、`cdk deploy --all` か
  `OpenReception-Web-<env> OpenReception-CfMonitoring-<env>` の順でデプロイする。
- **destroy の順序**: 参照の consumer である本 Stack を **WebStack より先に** destroy する
  （cross-region 参照が残っていると WebStack 側の export 削除がブロックされる）。
- 4xxErrorRate のアラームは持たない（ボット由来のノイズ源。可用性は 5xx + Lambda Errors で
  検知できる）。
- 認証情報なしで `cdk synth` した場合（`CDK_DEFAULT_ACCOUNT` 未解決）、この Stack は synth
  対象から除外される（cross-region 参照に concrete account が必要なため。deploy 時は常に解決）。

### alarmEmail の運用

- 通知先メールは **`-c alarmEmail=ops@example.com`** をデプロイコマンドで都度渡す
  （WebMonitoringStack / CloudFrontMonitoringStack / MonitoringStack 共通）。未指定なら
  Topic は作られるが購読者なし
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
# CfMonitoring (us-east-1) は WebStack の distributionId を cross-region 参照しているため先に destroy する
cd infra && npx cdk destroy OpenReception-CfMonitoring-dev -c env=dev
cd infra && npx cdk destroy OpenReception-WebMonitoring-dev OpenReception-Web-dev -c env=dev
cd infra && npx cdk destroy OpenReception-Monitoring-dev OpenReception-Notification-dev -c env=dev
```

> prod の S3 バケットは `RemovalPolicy.RETAIN`。destroy 後も残るため手動削除する。
