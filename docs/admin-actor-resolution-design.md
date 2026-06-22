# 管理 actor 解決の設計（実 actor 解決 increment 1）

関連: #80（マルチテナント基盤）・#85（管理画面フロント基盤）・#70（Entra ID 認証）

## 目的

各 admin API / レイアウトが使う「認可主体（`Actor`）」を、実セッション / Entra クレームから
**中央モジュール `src/lib/auth/actor.ts` で解決**する。これまでの暫定実装（管理セッションが
有効なら常に `developer` 相当の `Actor` を返す）を廃し、ロール / テナント境界を実際に効かせる。

## 2 つのロール体系の関係

| 体系 | 定義 | 責務 |
| --- | --- | --- |
| `AdminRole`（`src/domain/auth/roles.ts`, #70） | `'Admin' \| 'SiteManager' \| 'Viewer'` | 認証ソース（Entra App Role claim）→ 管理ロールの写像 |
| `TenantRole` + `RoleAssignment`（`src/domain/tenant/*`, #80） | `'developer' \| 'tenant_admin' \| 'site_manager' \| 'viewer' \| 'kiosk_device'` ＋ テナント/サイト境界 | 「解決済みロール × テナント/サイト境界」の認可判定 |

本モジュールは前者から後者へ写像し、env 由来の境界（テナント/サイト）を束ねて `Actor`
（`Pick<AdminUser, 'assignments' | 'status'>`）を生成する。認可判定そのものは #80 の純関数
（`canAccessTenant` / `canAccessSite` / `accessibleTenants`）と #85 の `canEnterArea` に委譲する。

## 写像表（`adminRoleToTenantRole`）

| AdminRole（Entra） | TenantRole | RoleAssignment の境界 |
| --- | --- | --- |
| `Admin` | `tenant_admin` | `tenantId` 必須・`siteId=null`（テナント全体） |
| `SiteManager` | `site_manager` | `tenantId` + `siteId` 必須（claim siteId → なければ `defaultSiteId`） |
| `Viewer` | `viewer` | `tenantId` 必須・`siteId` 任意（本増分では `null`） |
| （なし） | `developer` | env allowlist 経由でのみ付与（後述） |

`site_manager` で siteId を確定できない場合は当該割り当てを作らない（fail closed）。
結果として割り当てが 1 件も無ければ `Actor` は `null`（route 側 401 / レイアウトでリダイレクト）。

## developer（全テナント横断）付与方針 — 最小権限

`developer` は **明示設定がある時だけ** 付与する。Entra App Role / 共有パスワードからは
**自動付与しない**。

- Entra 経路: `OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS`（カンマ区切り、大文字小文字無視）に
  トークンの `email`（無ければ `preferred_username`）が含まれる場合のみ、`developer` 割り当てを
  追加する（既存ロールに重ねる）。
- password 経路: `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` を明示した場合のみ。

## 設定 env

| env | 既定 | 説明 |
| --- | --- | --- |
| `OPEN_RECEPTION_DEFAULT_TENANT_ID` | `internal` | 既定テナント ID（プロビジョニング済み seed テナントに一致、#171） |
| `OPEN_RECEPTION_DEFAULT_SITE_ID` | `default-site` | `site_manager` の siteId を claim から取れない場合の既定（seed サイト） |
| `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE` | `tenant_admin` | password セッションに与える `TenantRole`。`developer` を許すのは明示時のみ。不正値は安全側で `tenant_admin` |
| `OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS` | （空） | developer を付与するメール allowlist |

## モジュール構成

純関数（テスト対象, `actor.test.ts`）:

- `adminRoleToTenantRole(AdminRole): TenantRole`
- `buildAssignment(role, config, claimSiteId?): RoleAssignment | null`
- `buildActorFromEntraRoles(rolesClaim, config, claims?): Actor | null`
- `buildActorFromPasswordSession(config): Actor | null`
- `buildActorConfig(env): ActorConfig`

非純粋ラッパ（薄い）:

- `hasValidAdminSession(): Promise<boolean>` — cookie の入口判定（旧 `reservation/request.ts` から移設）。
- `resolveAdminActor(): Promise<Actor | null>` — cookie を読み、password セッション
  （`verifySession` で `role==='admin'`）→ `buildActorFromPasswordSession`、Entra トークンがあれば
  `verifyEntraToken`（JWKS 署名検証込み）を通して roles claim → `buildActorFromEntraRoles`。
  両方無効なら `null`。password を Entra より優先する。

`reservation/request.ts` と `tenant/request.ts` は `@/lib/auth/actor` から
`resolveAdminActor` / `hasValidAdminSession` を re-export し、既存 import 互換を保つ。

## レイアウトでの適用

- `src/app/admin/layout.tsx`: `resolveAdminActor()` → `canEnterArea(actor, 'admin')`。
  未認証 / テナント割り当てなしは `/admin/login` へリダイレクト。nav の表示ロールは
  解決済み actor の割り当てから導く（暫定の固定ロールを廃止）。`/admin/login` 自身は
  認証前に表示する必要があるためガード・共通シェルを適用しない（middleware が付与する
  `x-or-pathname` ヘッダで判定。`/admin/login` は middleware の公開パス）。
- `src/app/platform/layout.tsx`: `canEnterArea(actor, 'platform')`（developer のみ）。
  未認証は `/admin/login`、認証済み非 developer は `/admin` へ。

middleware（`src/proxy.ts`, Next 16 では旧 middleware）は引き続き `/admin/*`・`/api/admin/*`
の認証境界を担い、本増分で `NextResponse.next` 成功パスにリクエストヘッダ `x-or-pathname` を
付与してレイアウトへ現在パスを渡す。

## 検証ギャップと前提（重要）

- **Entra トークン検証**: `resolveAdminActor` は middleware (`src/proxy.ts`) と同じ
  `verifyEntraToken`（RS256 / JWKS 署名・issuer・audience・exp/nbf）を通してから claim を信頼する。
  トークンを未検証のまま actor 解決に使わない。JWKS は 10 分キャッシュ（`createJwksResolver`）。
- **テナント/サイト境界**: ~~env 由来の単一既定~~ → **#80 increment 2 で実 `AdminUser`
  ストアを導入し解消済み**。Entra ログインは検証済み subject（`oid`/`sub`）→ AdminUser を
  `getBackend()`（memory/dynamodb）から解決し、当該ユーザーの**実 `assignments`**で
  テナント/サイト境界を決める（env 既定テナントへ束ねない）。詳細は下記「increment 2」。
- **password セッションは email を持たない**ため、Entra のような per-user allowlist を適用できず
  `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE` 一律で制御する（共有パスワードは PoC / 単一テナント想定）。

## increment 2（#80）: 実 AdminUser ストアによるテナント分離 — 実装済み

実 `AdminUser` ストアを `src/lib/tenant/admin-user-store.ts` に追加し、`getBackend()`
（`DATA_BACKEND=memory|dynamodb`、既存業務データと同じ流儀）で永続化する。コレクション名は
`admin_user`。

- **解決キー**: `findBySubject(subject)`（Entra `oid`/`sub`、認証連携の正キー）→ 無ければ
  `findByEmail(email)`（補助）。AdminUser は小規模のため `list()` 走査（LogStore.findBy の
  パーティション走査フォールバックと同じ扱い。GSI 化は将来増分）。
- **型拡張**: `AdminUser.entraSubject?`（`oid` 優先）を追加。email 変更に追従できるよう email と
  独立に保持。`AdminUserRepository` に `findBySubject` を追加（memory 実装も対応）。
- **actor 解決**: `resolveAdminActor` の Entra 経路を、検証済み `subject`/`email` で
  `resolveActorFromStore` → `buildActorFromAdminUser`（**実 `assignments` を正**、env 既定
  テナントへ束ねない）に変更。純関数 `buildActorFrom*` は不変、ストア解決は薄い async ラッパ。
- **password セッションは従来どおり** env 設定（`buildActorFromPasswordSession`）。理由: 共有
  パスワードは email/subject を持たず per-user 解決ができないため（PoC / 単一テナント想定）。
- **Entra 未登録ユーザーの扱い**（最小権限が既定）: `OPEN_RECEPTION_ENTRA_UNREGISTERED`
  - `deny`（既定）: 解決できず `Actor=null`（401/リダイレクト）。真のテナント分離。
  - `env_roles`: 従来の env 既定境界 + roles claim フォールバック（移行期 / 単一テナント向け）。
- **プロビジョニング**: seed（`OPEN_RECEPTION_ADMIN_SEED_SUBJECT` / `..._EMAIL`）で `internal`
  テナントの tenant_admin を投入。本番は seed 非適用、`putAdminUser` で登録（管理 UI は #82/#90）。
- **PII 最小化**: `email` は表示・補助解決のみ。不要な PII は保存しない。

### 設定 env（increment 2 追加分）

| env | 既定 | 説明 |
| --- | --- | --- |
| `OPEN_RECEPTION_ENTRA_UNREGISTERED` | `deny` | 未登録 Entra ユーザーの扱い（`deny`=拒否 / `env_roles`=後方互換） |
| `OPEN_RECEPTION_ADMIN_SEED_SUBJECT` | （空） | dev seed の AdminUser に紐づける Entra subject（memory のみ） |
| `OPEN_RECEPTION_ADMIN_SEED_EMAIL` | `admin@internal.local` | dev seed の AdminUser email（memory のみ） |

## 次増分

1. `Tenant`/`Site`/`Device` の `getBackend()` 永続化（現状は `MemoryTenantStore`。#80 inc3）。
2. `TenantSwitcher` UI（developer / 複数テナント所属者の明示テナント選択）。
3. 各画面・各 route への細粒度認可（`canAccessTenant` / `canAccessSite` の per-screen 適用）。
4. Entra claim からの siteId / tenantId 取り出し（App Role に加えた group / カスタム claim 連携）。
5. AdminUser 管理 UI（#82/#90）と、subject/email の GSI 解決（規模拡大時）。
