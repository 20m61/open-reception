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
| `OPEN_RECEPTION_DEFAULT_TENANT_ID` | `default` | 既定テナント ID（実 AdminUser ストア導入までの暫定境界） |
| `OPEN_RECEPTION_DEFAULT_SITE_ID` | （なし） | `site_manager` の siteId を claim から取れない場合の既定 |
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
- **テナント/サイト境界は env 由来の単一既定**: 実 `AdminUser` ストア（Entra subject →
  AdminUser / `assignments` 永続化）が未実装のため、現状はすべての管理ユーザーが
  `OPEN_RECEPTION_DEFAULT_TENANT_ID` 配下に束ねられる。**真のマルチテナント分離は次増分で
  AdminUser ストアを入れるまで成立しない**。本増分の目的は「ロール境界（read/write・
  platform/admin・developer 非自動付与）を実際に効かせる」ことにある。
- **password セッションは email を持たない**ため、Entra のような per-user allowlist を適用できず
  `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE` 一律で制御する（共有パスワードは PoC / 単一テナント想定）。

## 次増分

1. 実 `AdminUser` ストア（DynamoDB）: Entra subject → AdminUser / `assignments` を永続化し、
   env 既定ではなく実データでテナント/サイト境界を解決する。
2. `TenantSwitcher` UI（developer / 複数テナント所属者の明示テナント選択）。
3. 各画面・各 route への細粒度認可（`canAccessTenant` / `canAccessSite` の per-screen 適用）。
4. Entra claim からの siteId / tenantId 取り出し（App Role に加えた group / カスタム claim 連携）。
