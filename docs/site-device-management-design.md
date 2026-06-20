# 拠点・受付端末管理 UI 設計 (issue #87)

本書は #87（拠点 Site・受付端末 Device の管理 UI）を increment（増分）方式で実装する
ための設計。基盤は #80（マルチテナント: `docs/multitenant-design.md`）、IA は
#85（管理画面フロント基盤: `docs/admin-frontend-design.md`）に従う。

## 用語と階層

`docs/multitenant-design.md` の定義に準拠する。

- **Tenant**: 導入先企業・組織。境界の最上位。
- **Site**: Tenant 配下の受付設置拠点（本社受付 / 名古屋支店 など）。状態 `active|suspended`。
- **Device**: Site 配下の受付端末。既存 **Kiosk（#18）をテナント境界へ乗せた表現**。
  状態 `active|revoked`（既存 `Kiosk.enabled` に対応）。

関係: **Tenant 1—\* Site 1—\* Device**。

## increment 1（このトラックの範囲・実装済み）

Issue #87 の画面のうち、まず **Site 管理を主**とし、Site⇔Device の紐づけ表示まで実装する。
Device（端末）の作り替えは行わない（既存 kiosks 管理 #18 との二重管理を避ける）。

### 実装範囲

- ルート `/admin/sites`: 拠点一覧・作成・名称編集・有効/停止 UI（`SitesManager`）。
  - Tenant > Site > Device の階層が分かるよう、各拠点に **端末数 / オンライン端末数** を表示。
  - 端末トークン等の機密は表示しない（数の把握のみ）。
- API `/api/admin/sites`（GET 一覧 / POST 作成）・`/api/admin/sites/[id]`（GET / PATCH 更新）。
  - 既存 admin API 様式（`resolveAdminActor` → 401、`tenantId` スコープ、`ServiceResult`→HTTP）。
- サービス層 `src/lib/tenant/site-service.ts`（`SiteService`）。
  - 認可は #80 の純関数に委譲: 一覧/取得は `canAccessTenant`/`canAccessSite`(read)、
    名称・状態更新は `canAccessSite`(write)。
  - **新規サイト作成はテナント全体操作**のため `developer` / `tenant_admin` のみ許可
    （site_manager はサイト単位権限のため不可）。`canAccessTenant(write)` は site_manager でも
    真になりうるので、作成判定は専用の `canManageTenant` で「テナント全体スコープの write」を要求する。
- 永続化: in-memory（`MemoryTenantStore` / `src/lib/tenant/store.ts` の dev seed）。
  単一テナント互換のため `internal` テナント + `default-site`、既存 `kiosk-dev` 対応 Device を投入。
- ナビ: `src/components/admin/navigation.ts` の `operations` グループに `/admin/sites`（ラベル「拠点」）
  を追加（受付端末の前）。表示は TENANT_VIEWERS（viewer も閲覧可）、書込は API 側で再検証。
- 監査: `site.created` / `site.updated` を PII なし（id / name / status のみ）で記録。

### 認可マトリクス（inc1 実装）

| 操作 | developer | tenant_admin | site_manager | viewer |
| --- | --- | --- | --- | --- |
| 一覧/取得 | 全テナント | 自テナント全サイト | 権限のあるサイトのみ | 自テナント（閲覧のみ） |
| 作成 | 可 | 可 | **不可** | 不可 |
| 名称/状態更新 | 可 | 可 | 自サイトのみ | 不可 |

テナント越境（他テナントの Site/Device）は全ロールで拒否（developer 除く）。

## Device / Kiosk 統合方針

現状、端末は 2 系統で表現されている。

- 既存: `src/domain/kiosk/types.ts` の `Kiosk`（id/displayName/location/enabled）+
  `/admin/kiosks`・`KiosksManager`（#18）。token 登録・失効・設定取得まで実装済み。
- 新規: `src/domain/tenant/types.ts` の `Device`（tenantId/siteId 束縛つき・status）。#80 で型のみ定義。

**方針**: `Device` を正とし、`Kiosk` を Device の一表現として段階的に寄せる
（`docs/admin-frontend-design.md`: `devices` ← `/admin/kiosks`）。inc1 では作り替えず、
SiteService 内で `DeviceRepository.listDevices(tenantId, siteId)` を Site の紐づけ集計
（端末数・オンライン数）にのみ使う。dev seed は既存 `kiosk-dev` に対応する Device を 1 件持つ。

## increment 2 以降（次増分・残課題）

- `/admin/devices` ルートと受付端末一覧・詳細（#87 の Device 画面要件: heartbeat / 端末種別 /
  token 登録状態 / メンテナンス表示）。Kiosk→Device 統合の本実装をここで行う。
- 端末の有効/無効切り替え・**token 再発行（確認ダイアログ + 監査）**・オフライン最終接続時刻表示。
- オンライン状態の実データ化（inc1 は `status` を稼働近似として扱う。実際の heartbeat 取得が必要）。
- 複数テナント所属時の **Tenant 切り替え UI** と現在操作中 Tenant/Site の明示（inc1 は `internal` 固定）。
- 実 actor 解決（Entra/Cognito クレーム → AdminUser/RoleAssignment 写像）。inc1 は管理セッション有効なら
  developer 相当の暫定 actor（`resolveAdminActor`、#97 と共通）。
- 永続化の DynamoDB シングルテーブル実装と `getBackend()` 接続（`docs/multitenant-design.md` §データ設計）。

## 既知の制約

- actor が developer 固定のため、ロール別表示/認可の差は単体テスト（`site-service.test.ts`）で
  網羅し、画面上の差分は実 actor 解決後に効く。
- Site 詳細の個別ページ（`/admin/sites/[id]`）は inc1 では一覧内編集（インライン）に留め、
  詳細画面は次増分。
