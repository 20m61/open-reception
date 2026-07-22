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

## 実行時解決 `resolveProviderForTenant` (#405 Inc3)

通話 / 通知 / トークン発行の各生成点は、資格情報を**グローバル `VONAGE_*` env から読まず**、
`resolveProviderForTenant(tenantId)`（`src/lib/platform/provider-resolution.ts`, **server-only**）で
テナント設定から解決する。

- 解決順（**env フォールバックは無い**）:
  1. `TenantProviderConfig` が `provider='vonage'` かつ `enabled` かつ secret set → **vonage**
     （非秘密設定 + secret を返す。secret は `SecretValue` の redacted wrapper のまま）。
  2. それ以外（未設定 / `provider='mock'` / disabled / secret 欠如）→ **mock**（fail-closed）。
- secret 値は解決層で生値化せず、接続情報を組む末端 builder でのみ `reveal()` する。
  解決結果を serialize しても平文は出ない（`SecretValue.toJSON`＝`[redacted]`）。
- テナント境界: `tenantId` は**認可済みコンテキスト由来のみ**渡す。secret 参照名は
  `secretRef(tenantId, provider)` で名前空間分離し、他テナントの secret を組み立てられない。

生成点の結線状況:

| 生成点 | 関数（テナント経由） | 旧 env（撤去） |
| --- | --- | --- |
| 通話 adapter | `resolveCallAdapter(tenantId, staff)`（`src/lib/call/adapter-factory.ts`） | `VONAGE_ENABLED` ほか |
| トークン session service | `resolveVonageSessionService(tenantId)`（同上） | 同上 |
| 通知 adapter | `resolveVonageAdapterForTenant(tenantId)`（`src/server/notification/vonage-adapter.ts`） | `VONAGE_NOTIFY_*` / `VONAGE_SECRET_ARN` |
| 取次 Provider（#374） | `resolveProviderForTenant`（純 mock 経路。#4 で実 Provider へ） | （env 参照なし） |

secret bundle（`SecretValue` が包む JSON）の形:

- 通話 / トークン: `{ "apiKey": "...", "apiSecret": "...", "privateKey": "<PEM>" }`（`applicationId` は非秘密設定側）。
- 通知: `{ "endpoint": "https://.../notify", "token": "...", "timeoutMs": 5000 }`（`timeoutMs` 任意）。

旧シム `getCallAdapter` / `getVonageSessionService`（tenantId を取らない）は env を読まず常に
Mock / null を返す後方互換のみ。tenantId を持てる呼び出し点は `resolve*` へ移行する（#4 の実結線）。

## 旧 VONAGE_* env からの移行

運用中に旧グローバル env を設定していた環境は、以下でテナント設定へ移す（**破壊的変更**: env のままでは
Vonage が有効化されない）。

1. `PROVIDER_SECRET_BACKEND` を選ぶ（`memory`=dev/CI、`secrets-manager`=本番。上表 §環境変数）。
2. `/platform/integrations`（developer 専用）で対象テナントを選び、`provider=vonage` / `enabled=true` と
   非秘密設定（`applicationId` = 旧 `VONAGE_APPLICATION_ID`・`fromNumber`・`timeoutMs`）を保存する。
3. secret を **write-only** で登録する（応答は presence のみ・値は echo されない）:
   - 通話/トークン用: 旧 `VONAGE_API_KEY` / `VONAGE_API_SECRET` / `VONAGE_PRIVATE_KEY` を
     `{ "apiKey", "apiSecret", "privateKey" }` の bundle として。
   - 通知用: 旧 `VONAGE_NOTIFY_ENDPOINT` / `VONAGE_NOTIFY_TOKEN`（または `VONAGE_SECRET_ARN` で
     解決していた `{ endpoint, token }`）を `{ "endpoint", "token", "timeoutMs"? }` の bundle として。
   - 参照名は `tenants/<tenantId>/vonage`。`secrets-manager` backend では
     `<PROVIDER_SECRET_PREFIX>/tenants/<tenantId>/vonage` に作成される。
4. 動作確認後、デプロイ環境から旧 `VONAGE_*` env（`ENABLED` / `APPLICATION_ID` / `API_KEY` /
   `API_SECRET` / `PRIVATE_KEY` / `NOTIFY_*` / `SECRET_ARN`）を撤去する。`CALL_ANSWER_SECRET`・
   `NEXT_PUBLIC_VONAGE_SDK_URL` は Vonage 資格情報ではないため対象外（残す）。

> 暫定の残存: `/platform/integrations` の presence 表示（#90/#93）は旧 env 名を後方互換で読む箇所が
> あるが、**資格情報の供給には使われない**。この表示のテナント設定 presence への移行は別増分
> （security/admin トラック）で行い、完了時に旧 env 参照を完全撤去する。

## 関連

- #405（テナント別 CCaaS プロバイダ設定）/ #4（Vonage 実装本体）/ #194（アプリ機密の Secrets Manager 化）
- #65（実 AWS 疎通検証のスタック先）/ #105（依存追加チェック。本 Inc は既存
  `@aws-sdk/client-secrets-manager` を再利用し新規依存追加なし）
