# 管理画面 Microsoft Entra ID 認証（オプション） (issue #70)

`/admin` と `/api/admin/*` を Microsoft Entra ID（旧 Azure AD）で保護するオプション機能。
受付端末・キオスク・来訪者導線（`/kiosk`, `/api/kiosk/*`）には**一切認証を追加しない**。

既定は `none`（既存のパスワード認証を維持）。`entra` を選ぶとパスワード認証を**置換**し、
Entra ID が発行する OIDC アクセストークン（JWT）を検証してロール認可する。

## 実装済み（この環境で検証可能）

- 設定ゲート（`ADMIN_AUTH_PROVIDER` / `ADMIN_AUTH_REQUIRED`）と本番 fail-closed ガード
- **Entra アクセストークン（RS256）の検証**: JWKS 公開鍵で署名・`iss`・`aud`・`exp`/`nbf`・`roles` を検証（Web Crypto のみ、Edge 対応）
- App Role → 管理ロール（`Admin` / `SiteManager` / `Viewer`）の写像と認可（Viewer は読み取り専用＝書き込み API は 403）
- middleware で `/admin`・`/api/admin/*` のみ保護（未認証は 401／ページはログインへ）
- ログイン導線（Authorization Code + PKCE、Client Secret 不要）: `/api/admin/auth/entra/start` → Entra → `/api/admin/auth/entra/callback`。callback は state を定数時間風比較で照合し、Entra 側 `?error=`（同意拒否等）を尊重して `/admin/login?error=` へ誘導。ログイン画面は既知エラーコードを機密を含まない日本語へ正規化して表示する。
- secret/トークンをクライアントへ渡さない（cookie は httpOnly、`'use client'` からの secret 参照を静的ガードで禁止）
- **認証方式設定ページ `/admin/auth`**（API `GET /api/admin/auth`）: provider 切替状態と Entra 必須設定（`issuer`/`audience`/`jwksUri`/`clientId`/`allowedRoles`）の **有無のみ**を表示する。issuer/clientId 等の値・Client Secret・トークンは API も画面も返さない（presence=`set|missing` と許可ロール列挙のみ）。閲覧は書き込み可能な管理ロール（`tenant_admin` 以上）に限定し viewer は 403。

### #93（`/admin/integrations`）との役割分担

| 画面 | 担当 | 対象 |
| --- | --- | --- |
| `/admin/integrations`（#93） | 認証方式＋外部連携＋シークレットの横断一覧 | ログイン方式の有効/無効・Vonage 連携・secret 状態 |
| `/admin/auth`（#70・本機能） | Entra ID 認証の詳細設定状態 | provider 切替・Entra 必須設定の個別 presence・有効化導線 |

どちらも同じ `src/lib/auth/admin-auth-config` を参照し、ロール定義・config 検証を重複させない。`/admin/integrations` は「有効か」、`/admin/auth` は「どの設定が揃っているか」を担う。

### 有効化手順（オプション）

1. Entra ID 側のアプリ登録（下記「アプリ登録」）を行い、テナント ID・クライアント ID を取得する。
2. server-only env を設定する: `ADMIN_AUTH_PROVIDER=entra`、`ENTRA_TENANT_ID`、`ENTRA_CLIENT_ID`（必要なら `ENTRA_AUDIENCE` / `ENTRA_ISSUER` / `ADMIN_ALLOWED_ROLES`）。
3. デプロイ後 `/admin/auth` で各設定が `設定済み` になっていること・`設定OK` バッジを確認する。
4. `/admin/login` から「Microsoft でサインイン」でログインできることを確認する（実テナント検証は #65 にスタック）。
5. 無効化に戻すには `ADMIN_AUTH_PROVIDER=none`（既存パスワード認証へ）。本番では `ADMIN_AUTH_REQUIRED=false` は config 検証でエラー（middleware が 500 で fail-closed）。

> intended nav: `/admin/auth` は ガバナンス グループ（`/admin/integrations` の隣、`tenant_admin` 以上）に配線予定。`navigation.ts` への配線はオーケストレータが別途行う。

## #65 にスタック（外部リソース前提）

- 実テナントに対する**対話ログインの e2e**（実 Entra アプリ登録・ユーザー・App Role が必要）
- **Cognito 経由構成（第一候補）** と **AWS CDK**（Cognito / API Gateway Authorizer / Secrets Manager / CloudWatch）
- 拠点単位アクセス制御（`AdminAccessProfile` の DB 管理）の本実装

## 環境変数

```env
ADMIN_AUTH_PROVIDER=none        # none | cognito | entra（既定: none）
ADMIN_AUTH_REQUIRED=true        # SSO 時のみ意味を持つ。false は本番で禁止（fail-closed）
ENTRA_TENANT_ID=...
ENTRA_CLIENT_ID=...
ENTRA_ISSUER=https://login.microsoftonline.com/{tenantId}/v2.0   # 省略時は TENANT_ID から導出
ENTRA_AUDIENCE=api://{clientId}                                   # 省略時は CLIENT_ID
ENTRA_SCOPE=openid profile email                                 # 任意
ADMIN_ALLOWED_ROLES=OpenReception.Admin,OpenReception.SiteManager,OpenReception.Viewer
```

すべて **server-only**（`NEXT_PUBLIC_` を付けない）。PKCE 構成のため **Client Secret は不要**。

## Entra ID 側のアプリ登録（手順概要）

1. Microsoft Entra 管理センター → アプリの登録 → 新規登録（個人の Entra ID Free テナントで検証可）。
2. リダイレクト URI（Web）に `${ORIGIN}/api/admin/auth/entra/callback` を追加。
3. 「トークン構成」/「API のアクセス許可」で `openid` `profile` `email` を付与。
4. 「アプリ ロール」に `OpenReception.Admin` / `OpenReception.SiteManager` / `OpenReception.Viewer` を定義。
5. 「エンタープライズ アプリケーション」→ ユーザーとグループ で管理者にロールを割り当て。
6. テナント ID・クライアント ID を環境変数へ設定（Client Secret は不要）。

## ロールと権限

| App Role | 管理ロール | 権限 |
| --- | --- | --- |
| `OpenReception.Admin` | Admin | 全操作（読み取り/書き込み） |
| `OpenReception.SiteManager` | SiteManager | 拠点設定・部署・担当者等の読み書き |
| `OpenReception.Viewer` | Viewer | 読み取りのみ（書き込み API は 403） |

`roles` claim に既知ロールが無い場合・許可外ロールの場合はアクセスを拒否する。

## セキュリティ

- JWT の `iss` / `aud` / 署名 / `exp`・`nbf` を検証。`alg` は RS256 のみ許可（`none` 等は拒否）。
- 公開鍵（JWKS）のみ利用し、private key / Client Secret はサーバにも置かない（PKCE）。
- アクセストークンは httpOnly cookie に保持し、レスポンス本文へ出さない。
- 受付端末・キオスクに管理者トークンを保持させない（保護対象は `/admin` 系のみ）。
- 本番で `ADMIN_AUTH_REQUIRED=false` の場合、middleware が 500（fail-closed）で管理を開かない。
