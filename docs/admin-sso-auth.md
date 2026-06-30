# 管理ログインの認証（選択式マルチプロバイダ / Cognito 既定） — issue #238

管理ログインは **プロバイダ選択式**。`ADMIN_AUTH_PROVIDER` で `none`（パスワード）/ `cognito`
（埋め込み SRP・既定）/ `entra`（Microsoft リダイレクト）を切替える。検証層は provider 非依存の
**汎用 OIDC 検証**（`src/lib/auth/entra.ts` の `verifyOidcToken`）で共通化している。

旧 `docs/admin-entra-auth.md`（Entra 専用）の一般化版。

## プロバイダ

| provider | ログイン | トークン | ロール claim | 既定 |
| --- | --- | --- | --- | --- |
| `none` | 自前パスワードフォーム | 署名セッション cookie | — | **ローカル/CI/e2e** |
| `cognito` | **自前フォーム + SRP**（Hosted UI 不使用） | Cognito ID トークン | `cognito:groups` | **デプロイ環境** |
| `entra` | Microsoft リダイレクト | Entra access トークン | `roles` | 任意 |

> **既定の二段構え**: コード既定（`getAdminAuthConfig` の fallback）は `none`。デプロイ環境は
> `infra/lib/config/environments.ts` の `auth.adminProvider`（dev/staging/prod = `cognito`）を
> bin が `ADMIN_AUTH_PROVIDER` に畳み込むため **deploy 既定は cognito**。ローカル/CI/e2e は CDK を
> 通らず未設定＝`none` のまま（既存パスワードフロー無改変）。

## Cognito 埋め込みログイン（SRP・Hosted UI 不使用）

Hosted UI へリダイレクトせず、自前 `/admin/login` フォーム（user+pass, `AdminCredentialsLogin`）から
`POST /api/admin/login` へ送る。サーバが **SRP（USER_SRP_AUTH）** で認証し、パスワードを Cognito へ
**平文送信しない**（埋め込みフォームの PW はバックエンドまで TLS、そこから Cognito へは SRP 証明のみ）。

```
ブラウザ(自前フォーム) --PW(TLS)--> /api/admin/login
   └ createSrpSession → InitiateAuth(USER_SRP_AUTH) → PASSWORD_VERIFIER
       → signSrpSession → RespondToAuthChallenge → ID/Access トークン
   └ ID トークンを verifyOidcToken（issuer=UserPool, jwks, aud=ClientId, roles=cognito:groups）
   └ allowedRoles を満たせば SSO cookie に ID トークンを格納
proxy.ts が以降毎リクエスト verifyOidcToken（exp/署名/role）。
```

- SRP 暗号は自前実装せず `cognito-srp-helper`（Apache-2.0）に委譲。SDK は
  `@aws-sdk/client-cognito-identity-provider`。App Client は **client secret 無し**
  （`generateSecret:false`）・**USER_SRP_AUTH のみ**・**UserPoolDomain 無し（Hosted UI 無し）**。
- 実装: `src/lib/auth/cognito-srp.ts`（SRP ログイン）, `src/app/api/admin/login/route.ts`（cognito 分岐）,
  `src/lib/auth/admin-auth-config.ts`（cognito 設定）, `src/proxy.ts`（SSO 検証の汎用化）。

## インフラ（CDK）

`auth.adminProvider==='cognito'` のとき bin が `cognitoAuth:true` を渡し、`WebStack` が
Cognito **User Pool + App Client** を作成、`COGNITO_USER_POOL_ID/COGNITO_CLIENT_ID/COGNITO_REGION/
COGNITO_ISSUER` を server Lambda に注入する。`InitiateAuth(USER_SRP_AUTH)` は client secret 無しなら
**IAM 不要**（公開 API）。User Pool は selfSignUp 無効・パスワードポリシ強・id/access token 8h。

## 管理者ユーザーの provisioning

セルフサインアップは無効。管理者ユーザーと**グループ（ロール写像）**は運用で作成する:

```bash
POOL=<AdminUserPoolId 出力>; REGION=ap-northeast-1
# グループ（= ロール）。ADMIN_ALLOWED_ROLES と整合させる（例: OpenReception.Admin）。
aws cognito-idp create-group --user-pool-id "$POOL" --group-name OpenReception.Admin --region "$REGION"
# ユーザー作成 → 恒久パスワード設定 → グループ付与
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username admin@example.com \
  --message-action SUPPRESS --region "$REGION"
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username admin@example.com \
  --password '<Strong#Passw0rd>' --permanent --region "$REGION"
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username admin@example.com \
  --group-name OpenReception.Admin --region "$REGION"
```

`ADMIN_ALLOWED_ROLES`（例 `OpenReception.Admin,OpenReception.SiteManager,OpenReception.Viewer`）と
グループ名・`resolveAdminRole`（`src/domain/auth/roles.ts`）の写像を一致させる。

### 未登録 SSO ユーザーの扱い（重要）

`resolveAdminActor`（`src/lib/auth/actor.ts`）は subject/email で **AdminUser ストア**を引く。
未登録ユーザーの既定は **deny**（最小権限・真のテナント分離）。次のどちらかで運用する:

- **AdminUser を登録**（推奨・本番のマルチテナント運用）: ストアに subject 紐付けの AdminUser を作る。
- **`OPEN_RECEPTION_ENTRA_UNREGISTERED=env_roles`**（単一テナント / 検証）: 未登録でもトークンの
  グループ（ロール）＋既定テナント境界で Actor を組む。dev 検証はこれを使用。

> env 名は歴史的に ENTRA だが Cognito にも適用される（SSO 共通の未登録ポリシ）。

## デプロイ

`infra/lib/config/environments.ts` の既定で **deploy は cognito**。`ADMIN_AUTH_PROVIDER` を
appEnv で渡す必要はない（bin が畳み込む）。`-c appEnv='{"ADMIN_AUTH_PROVIDER":"none"}'` で明示退避も可。
`docs/deploy-aws.md` の originVerifySecret / 公開 base-URL 必須は引き続き必要。

## 依存（#105）

- `@aws-sdk/client-cognito-identity-provider`（Apache-2.0・AWS 公式・SDK v3 と整合）
- `cognito-srp-helper`（Apache-2.0・SRP 暗号。deps: crypto-js MIT / jsbn MIT / buffer MIT）

いずれも許容ライセンス。商用・SaaS 配信可。

## 非スコープ（inc2 以降）

- MFA / `NEW_PASSWORD_REQUIRED` 等の追加チャレンジ（現状 challenge_required で 401）。
- refresh トークンによるセッション延長（現状 token validity 8h）。
- 汎用 `oidc`（Okta/Google 等の任意 OIDC SSO・リダイレクト）プロバイダの login 導線。
