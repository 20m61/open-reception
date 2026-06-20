# マルチテナント基盤 設計 (issue #80)

open-reception を複数企業・複数拠点で安全に運用するためのテナント境界の方針。
単に各テーブルへ `tenantId` を足すのではなく、認証・認可・データ設計・S3 保存先・
受付端末・監査ログ・管理画面ルートまで含めて境界を定義する。

本書は increment（増分）方式で実装する。**今回の PR は increment 1（純粋ドメイン +
型 + リポジトリ interface + in-memory 実装 + テスト）のみ**。外部 I/O 実配線・
スキーマ実装・UI は後続増分に送る（末尾「increment 計画」参照）。

---

## 用語（Issue #80 準拠）

| 用語 | 意味 | 例 |
| --- | --- | --- |
| Tenant | 導入先企業・組織。境界の最上位。 | AVITA / アルティウスリンク |
| Site | Tenant 配下の受付設置拠点。 | 本社受付 / 名古屋支店 |
| Device | Site 配下の受付端末（既存 Kiosk をテナント境界へ乗せた表現）。 | iPad 受付端末 |
| AdminUser | 管理画面ログインユーザー。Tenant/Site に権限を持つ。 | 企業管理者 |

関連: **Tenant 1—\* Site 1—\* Device**。状態は Tenant/Site が `active|suspended`、
Device が `active|revoked`（既存 `Kiosk.enabled` と対応）。

---

## ロール表

| ロール | スコープ | できること | 書き込み |
| --- | --- | --- | --- |
| `developer` | 全テナント横断 | システム管理・横断確認・障害対応 | 可 |
| `tenant_admin` | Tenant 単位 | 企業全体の設定・拠点/ユーザー管理 | 可 |
| `site_manager` | Site 単位 | 拠点設定・通知先・端末設定の管理 | 可 |
| `viewer` | Tenant/Site 単位 | 受付履歴・設定の閲覧のみ | 不可 |
| `kiosk_device` | Device 単位 | 受付開始・セッション作成など端末 API のみ | 不可（端末専用 API） |

実装: `src/domain/tenant/types.ts`（`TenantRole` / `RoleAssignment` / `AdminUser`）。

### 既存 `src/domain/auth/roles.ts` との関係

`roles.ts` は **Entra App Role（roles claim）→ 管理ロール（Admin/SiteManager/Viewer）の
写像**（#70）という別責務。今回のテナントロールはそれとは別レイヤの「解決済みロール ×
テナント/サイト境界の認可判定」を担う。重複定義は避け、次増分で両者を橋渡しする
（Entra App Role → `TenantRole` + `RoleAssignment` のマッピング）。

---

## 認証・認可の方針

- 管理 API はクライアントが送る `tenantId` を**そのまま信用しない**。サーバ側の
  AdminUser（`RoleAssignment[]`）を正として境界を判定する。
- 未認証は `401`、権限不足は `403`。
- `developer` 以外は他テナントのデータへアクセス不可。
- `developer` は横断確認できるが、通常操作では明示的な Tenant 選択を前提にする
  （UI 側の責務。次増分）。

認可判定は純関数として `src/domain/tenant/authorization.ts` に集約する（increment 1）:

| 関数 | 用途 |
| --- | --- |
| `canRoleWrite(role)` | ロール単体の書き込み可否（viewer/kiosk_device は不可） |
| `canAccessTenant(actor, tenantId, op)` | テナント境界の read/write 判定 |
| `canAccessSite(actor, tenantId, siteId, op)` | サイト境界の判定（tenant_admin は全サイト、site_manager は割当のみ） |
| `canDeviceAct(actor, tenantId, siteId, deviceId)` | 端末トークンの束縛完全一致検証 |
| `accessibleTenants(actor)` | アクセス可能テナント集合（developer は `{scope:'all'}`） |

これらを middleware / route handler から再利用し、`403`/`401` の判定に使う（次増分で配線）。

---

## データ設計（DynamoDB シングルテーブル）— 次増分

Issue #80 のキー設計案を採用予定。**実装は次増分**（本増分は型と interface のみ）。

```txt
PK = TENANT#{tenantId}  SK = TENANT#PROFILE
PK = TENANT#{tenantId}  SK = SITE#{siteId}
PK = TENANT#{tenantId}  SK = SITE#{siteId}#DEVICE#{deviceId}
PK = TENANT#{tenantId}  SK = USER#{userId}
PK = TENANT#{tenantId}  SK = SESSION#{sessionId}
PK = TENANT#{tenantId}  SK = AUDIT#{timestamp}#{eventId}
```

GSI 候補（次増分で検討）: `SITE#{siteId}` / `USER#{userId}` / `DEVICE#{deviceId}` 起点。

PK にテナントを置くことで、クエリ自体がテナント境界に閉じる。リポジトリ interface
（`src/lib/tenant/repository.ts`）は `listSites(tenantId)` / `getSite(tenantId, id)` の
ように **tenantId/siteId を引数で必須**にし、保存先非依存でこの境界を表現する。
in-memory 実装（`memory-repository.ts`）も同じ境界でフィルタする。

既存 `src/lib/data/`（Collection/Singleton/LogStore）への統合（テナント単位の
コレクション名 or PK 前置）は次増分で行う。

---

## S3 / ファイル / ログ分離 — 次増分

テナント境界を prefix で分離する。

```txt
s3://{bucket}/tenants/{tenantId}/sites/{siteId}/...
s3://{bucket}/tenants/{tenantId}/devices/{deviceId}/...
s3://{bucket}/tenants/{tenantId}/sessions/{sessionId}/...
```

署名付き URL 発行時は、対象 prefix がログインユーザーの権限スコープ内であることを
`canAccessSite` 等でサーバ側検証する。実配線は次増分。

---

## 受付端末 / kiosk — 次増分

来訪者向け受付画面は管理ログインと分離。端末は `deviceToken`（署名付き、tenantId/
siteId/deviceId と有効期限・失効状態を束縛）で Site/Device に紐づける。端末 API は
`canDeviceAct` で束縛の完全一致を必ず検証する。token 発行・失効方式の実装は次増分
（既存 `src/lib/auth/kiosk.ts` / `src/domain/security/types.ts` と統合）。

---

## 監査ログ — 次増分

`AuditLog`（既存 `src/domain/reception/log.ts`）に `tenantId` / `siteId` / `userId` /
`deviceId` を追加し、操作主体と境界を記録する。PII は引き続き含めない。型拡張と
書き込み配線は次増分（他トラックの監査拡充と衝突しないよう調整）。

---

## 管理画面ルートへの tenantId 伝播 — 次増分

- ルート構成: `/admin/tenants/{tenantId}/...`（または現在テナントをセッション保持）。
- 複数テナント所属時の Tenant 切り替え UI、現在操作中の Tenant/Site の明示表示。
- `accessibleTenants(actor)` で選択肢を出し分ける。
- 実装は #85（管理画面フロント基盤）以降のクラスタで行う。

---

## 既存データ移行 — 次増分

既存単一テナント運用は `internal`（default）Tenant + `default-site` Site として維持する。
migration は次増分で用意する（受け入れ条件「既存運用は default Tenant として維持」）。

---

## increment 計画

### increment 1（本 PR・このトラックの範囲）

- `src/domain/tenant/types.ts`: Tenant/Site/Device/AdminUser 型・ブランド ID・状態・
  `TenantRole`/`RoleAssignment`・型ガード。
- `src/domain/tenant/authorization.ts`: テナント/サイト/端末境界の認可純関数。
- `src/lib/tenant/repository.ts`: 保存先非依存のリポジトリ interface。
- `src/lib/tenant/memory-repository.ts`: 単体テスト/dev 用 in-memory 実装。
- 各モジュールの vitest 単体テスト（境界・権限のテーブルテスト）。
- 本設計書。

### increment 2（このトラックの範囲・実装済み）

実 actor 解決(#117) で残った「全管理ユーザーが env 既定テナントへ集約される」状態を解消し、
真のテナント分離へ近づける（キーストン）。詳細は `docs/admin-actor-resolution-design.md`
§increment 2。

- [x] 実 `AdminUser` ストア（`src/lib/tenant/admin-user-store.ts`）を `getBackend()`
  （memory/dynamodb 両対応）で永続化。コレクション `admin_user`。
- [x] `AdminUser.entraSubject` 追加 + `AdminUserRepository.findBySubject`（memory 実装も）。
- [x] `resolveAdminActor` の Entra 経路を AdminUser ストアの**実 `assignments`** 解決へ変更
  （`resolveActorFromStore` / `buildActorFromAdminUser`、純関数 `buildActorFrom*` は不変）。
- [x] Entra 未登録ユーザーは既定で拒否（最小権限）。`OPEN_RECEPTION_ENTRA_UNREGISTERED=env_roles`
  で後方互換フォールバック。
- [x] seed / `putAdminUser` による最小プロビジョニング（管理 UI は #82/#90）。

### increment 3（このトラックの範囲・実装済み）

`Tenant`/`Site`/`Device` の永続化を `getBackend()` ベースへ移行し、管理画面に対象テナント
切り替え（TenantSwitcher）を載せた。詳細:

- [x] `Tenant`/`Site`/`Device` を `MemoryTenantStore` から `getBackend()` 永続化へ移行
  （`src/lib/tenant/data-repository.ts` の `DataBackedTenantStore`。コレクション `tenant`/
  `site`/`device`、AdminUser は inc2 の `admin_user` を再利用）。**repository interface は維持**し、
  `site-service.test.ts`/`device-service.test.ts`/`memory-repository.test.ts` は memory backend で
  緑のまま。`store.ts` の `getTenantStore()` を差し替え（seed は memory のみ有効）。
- [x] テナント選択の純粋ロジック（`src/lib/tenant/tenant-selection.ts`）:
  `selectableTenants` / `canSelectTenant` / `resolveActiveTenantId`（越境 cookie を安全側へ倒す）
  / `isSwitchable`。`accessibleTenants(actor)` を土台に developer=all / 所属テナントを導出。
- [x] TenantSwitcher（`src/components/admin/TenantSwitcher.tsx`）と server action
  （`select-tenant-action.ts`）。`AdminShell` の `tenantLabel` を `tenantSwitcher` slot へ差し替え、
  `admin/layout.tsx` で配線。単一所属は固定表示、developer/複数所属はドロップダウン切替。
- [x] 選択中テナントの解決導線（`active-tenant.ts` / cookie `or_active_tenant`、HttpOnly）。
  read 系画面はここから対象テナントを取得できる。

**セキュリティ（越境拒否）**: テナント選択は表示・操作対象の切り替え（UX）であり認可ではない。
クライアントが送る tenantId はそのまま信用せず、server action は `resolveAdminActor()` で actor を
サーバ側に解決し直して `canSelectTenant` で越境を拒否（権限外テナントの選択要求は cookie を
書き換えず無視）。cookie 値も `resolveActiveTenantId` が actor 基準で検証し、越境・失効時は安全側
（選択肢の先頭）へフォールバックする。最終的な認可は引き続き各 API / service が actor を正として
検証する。

### increment 4 以降（残課題）

- [ ] DynamoDB シングルテーブル実装（PK/SK・GSI）と `getBackend()` 統合（tenant 系）。
  inc3 は Collection 抽象（id 単位）の上に素直に載せ、PK=TENANT#... のキー最適化は未着手。
- [ ] 選択中テナントの per-screen 細粒度認可の全面適用（inc3 は最小導線のみ）。
- [ ] 全テーブル（Settings/Session/AuditLog 等）への `tenantId` 付与（usage/log は #89）。
- [ ] 管理 API の認可 middleware（`401`/`403`、tenantId 解決）。
- [ ] Entra App Role → `TenantRole`/`RoleAssignment` マッピング（#70 連携）。
- [ ] kiosk `deviceToken` 発行・失効方式の実装と端末 API 検証配線。
- [ ] S3 prefix `tenants/{tenantId}/...` の実配線と署名 URL のスコープ検証。
- [ ] `AuditLog` への tenantId/siteId/userId/deviceId 追加。
- [ ] 管理画面 Tenant/Site/Device 管理 UI と Tenant 切り替え（#85 以降）。
- [ ] 既存データの `internal` Tenant への migration。
- [ ] E2E: Tenant A から Tenant B のデータ・S3 署名 URL へアクセスできないこと。

---

## 受け入れ条件と本増分の対応

| 受け入れ条件 | 本増分 | 次増分 |
| --- | --- | --- |
| `tenant_admin` は自テナントのみ管理 | 判定純関数 ✅ | API 配線 |
| `site_manager` は許可サイトのみ管理 | 判定純関数 ✅ | API 配線 |
| `viewer` は編集で `403` | `canRoleWrite=false` ✅ | API で `403` 返却 |
| `developer` 横断・明示 Tenant 選択 | `accessibleTenants` ✅ | UI |
| 端末 API は束縛 tenant/site/device のみ | `canDeviceAct` ✅ | token 検証配線 |
| Tenant A が Tenant B へアクセス不可 | リポジトリ境界 ✅ | E2E 検証 |
| 既存運用を default Tenant で維持 | 設計記載 | migration |
| 監査ログに Tenant/Site/User/Device | 設計記載 | 型拡張・配線 |
| #70 Entra 連携へ接続可能 | ロール設計 ✅ | マッピング実装 |
