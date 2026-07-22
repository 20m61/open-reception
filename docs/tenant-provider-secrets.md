# テナント別 CCaaS プロバイダ secret（Secrets Manager バックエンド）(#405 Inc2)

テナントごとの CCaaS プロバイダ（まず Vonage）接続 secret を、テナント設定ストアではなく
**AWS Secrets Manager** に分離して保管する仕組みの設定方法。secret 値は write-only で、API/画面/
ログ/監査には presence（`set`|`missing`）のみが出る（`.claude/rules/pii-secret-minimization.md` §#405）。

> このドキュメントはコードとテストの範囲のみを記述する。**実 AWS への deploy（`cdk deploy`）は本
> increment では実施しない。** 実際の Secrets Manager 疎通検証は #65 にスタックし、deploy は
> `docs/deploy-aws.md` の手順に沿ってユーザー確認のうえ別途行う（secret 取り扱い変更のため）。

## 構成

- ドメイン interface: `TenantSecretStore`（`src/domain/provider-config/secret.ts`, Inc1）。
- 実装:
  - `InMemoryTenantSecretStore`（Inc1）… プロセス内 mock。dev/test/CI の既定。
  - `SecretsManagerTenantSecretStore`（Inc2, `src/domain/provider-config/secrets-manager-store.ts`）
    … Secrets Manager 実装。**server-only**（client から import 不可）。
- ファクトリ: `createTenantSecretStore(env)` / `getTenantSecretStore()`
  （`src/lib/platform/tenant-secret-store.ts`）が env で backend を選ぶ。

### 参照名 → シークレット名の写像

参照名 `tenants/<tenantId>/<provider>`（`secretRef()`）を、環境 prefix を冠した Secrets Manager
シークレット名へ写像する:

```
tenants/acme/vonage  →  <PROVIDER_SECRET_PREFIX>/tenants/acme/vonage
                        （例 open-reception/prod/tenants/acme/vonage）
```

`..`・絶対パス・空・二重スラッシュを含む参照名は fail-closed で拒否し、テナント名前空間の越境を防ぐ。

### 操作セマンティクス

| interface | Secrets Manager | 備考 |
| --- | --- | --- |
| `setSecret` | CreateSecret（未存在）/ PutSecretValue（存在時） | 冪等に再 set 可 |
| `clearSecret` | DeleteSecret（`RecoveryWindowInDays=30`） | 復旧猶予つき。ForceDelete は使わない。未存在は no-op |
| `hasSecret` | DescribeSecret | 削除予定（`DeletedDate`）は presence=false |
| `getSecret` | GetSecretValue | 未存在は null。値は `SecretValue` でラップ |

エラーは値・secretId を含まない静的メッセージへ正規化し、原因は `err.name` のみログする。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PROVIDER_SECRET_BACKEND` | `memory` | `memory`（mock）/ `secrets-manager`。未知値は fail-closed |
| `PROVIDER_SECRET_PREFIX` | （なし） | `secrets-manager` のとき必須。環境 prefix（例 `open-reception/prod`） |
| `AWS_REGION` | `ap-northeast-1` | Secrets Manager クライアントのリージョン |

`memory` 既定のため、ローカル/CI の現行動作は不変。

## CDK 配線（`infra/`）

`WebStack` に `providerSecretBackend` / `providerSecretPrefix` を渡すと（`bin/open-reception.ts` が
context から拾う）:

- server Lambda に `PROVIDER_SECRET_BACKEND` / `PROVIDER_SECRET_PREFIX` env を注入。
- 実行ロールに **テナント prefix 限定**の最小 IAM を付与:

  ```
  Actions:  secretsmanager:GetSecretValue, DescribeSecret, CreateSecret, PutSecretValue, DeleteSecret
  Resource: arn:aws:secretsmanager:<region>:<account>:secret:<prefix>/tenants/*
  ```

  アカウント全体のワイルドカード（`Resource: "*"`）は付けない。ARN 末尾の `*` は tenants 名前空間と
  Secrets Manager が付与する 6 桁ランダム接尾辞の両方を覆う。

- **シークレット実体は CDK では作らない**（設定 API から実行時に作成される）。

### デプロイ手順（ユーザー確認のうえ別途実施。本 increment では未実行）

```bash
# 1. OpenNext ビルド（リポジトリルート）
npm run build:open-next

# 2. secrets-manager backend を選んで synth（AWS 資格情報なしでもローカル synth 可）
cd infra
npx cdk synth -c env=prod \
  -c providerSecretBackend=secrets-manager \
  -c providerSecretPrefix=open-reception/prod

# 3. deploy（要ユーザー確認・実 AWS 資格情報。secret 取り扱い変更のため）
#    npx cdk deploy OpenReception-Web-prod -c env=prod \
#      -c providerSecretBackend=secrets-manager -c providerSecretPrefix=open-reception/prod
```

デプロイ後、設定 API（`/platform/integrations`）から各テナントの secret を write-only 登録すると、
`<prefix>/tenants/<tenantId>/<provider>` シークレットが実行時に作成される。CloudTrail で
`CreateSecret`/`PutSecretValue`/`DeleteSecret` を監査する（値は記録されない）。

## 関連

- #405（テナント別 CCaaS プロバイダ設定）/ #4（Vonage 実装本体）/ #194（アプリ機密の Secrets Manager 化）
- #65（実 AWS 疎通検証のスタック先）/ #105（依存追加チェック。本 Inc は既存
  `@aws-sdk/client-secrets-manager` を再利用し新規依存追加なし）
