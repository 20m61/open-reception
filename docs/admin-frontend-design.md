# 管理画面フロント基盤・情報設計 (issue #85)

open-reception の管理画面のルート設計・情報設計（IA）・権限/テナント境界・既存ページの
位置づけを定義する。本書で **ルート名を確定** し、#90（platform コンソール）/ #82（admin
コンソール）/ #94（SPA ライク化）が参照する基準とする。

関連: #80（マルチテナント基盤・ロール）, #90（platform コンソール）, #94（SPA 方針）。

## 1. 責務別ルート分離

利用者の責務ごとにルートエリアを分離する。

```txt
/admin/*       テナント管理者・拠点担当者向け（日常運用）
/platform/*    総合開発者・プラットフォーム運用者向け（テナント横断・危険操作）
```

`/developer` ではなく **`/platform` を採用** する。理由: 役割（誰）ではなく対象領域
（プラットフォーム全体の運用）でルートを表すほうが、将来 developer 以外の運用ロールを
足すときに破綻しないため。ロールは `developer`（#80）が入口になる。

## 2. 情報設計（ナビ階層）

ルート/IA の単一の真実は `src/components/admin/navigation.ts`（`ADMIN_NAV` /
`PLATFORM_NAV`）。本書はその意図を説明する。

### 2.1 `/admin/*`（テナント側）

| グループ     | 既定ロール                                  | 画面（確定ルート）                                            |
| ------------ | ------------------------------------------- | ------------------------------------------------------------ |
| 概況         | developer/tenant_admin/site_manager/viewer  | `/admin`(dashboard)                                          |
| 日常運用     | 同上                                        | `/admin/receptions`, `/admin/kiosks`(devices), `/admin/departments`, `/admin/staff` |
| 受付体験     | developer/tenant_admin                       | `/admin/assets`, `/admin/motions`, `/admin/voice`           |
| ガバナンス   | developer/tenant_admin/site_manager/viewer  | `/admin/security`(auth, tenant_admin限定), `/admin/audit`(audit-logs) |

#85 候補ルートとの対応（将来の正式名 ← 現行実装ルート）:

- `dashboard` ← `/admin`
- `sites` … 新設予定（#80 の Site 管理。現状は未実装）
- `devices` ← `/admin/kiosks`（Kiosk を Device へ寄せる）
- `call-routes` … 新設予定（呼出ルーティング。現状 voice/通話系に内包）
- `messages` … 新設予定（表示文言・通知文）
- `auth` ← `/admin/security`（アクセス制御・認証設定）
- `usage` / `costs` … 新設予定（利用量・コスト概算）
- `audit-logs` ← `/admin/audit`

> 既存ルート名は **互換のため現状維持**。正式名へは段階的に rename/alias で寄せる
> （本増分では rename しない＝非破壊）。

### 2.2 `/platform/*`（運用側、#90 が本実装）

| グループ       | ロール    | 画面（確定ルート）                                              |
| -------------- | --------- | -------------------------------------------------------------- |
| 概況           | developer | `/platform`(dashboard)                                         |
| テナント運用   | developer | `/platform/tenants`⚠, `/platform/feature-flags`, `/platform/integrations` |
| 信頼性         | developer | `/platform/observability`, `/platform/maintenance`⚠, `/platform/audit-logs` |

⚠ = 破壊的操作を含む導線（`danger` フラグ。DangerZone 隔離対象）。

## 3. 権限境界・テナント境界・危険操作

- **フロントの権限制御は UX 上の表示制御に留める**（`navigation.ts` の `visibleNav` /
  `route-guard.ts` の `canEnterArea`）。最終的な認可は **必ず API 側** で `role` /
  `tenantId` / `siteId` / `permission` を検証する（#80 `authorization.ts` を再利用）。
- **route guard 雛形**: `src/components/admin/route-guard.ts` の `canEnterArea(actor, area)`。
  - `/platform` … `developer`（全テナント横断 = `accessibleTenants` が `scope:'all'`）のみ。
  - `/admin` … 何らかのテナントにアクセスできる actor（developer 含む）。
  - 未認証 / 非 active / 割り当て無し → `unauthenticated`。
  - 適用例は admin/platform の `layout.tsx` に方針コメントで記載。**厳密な actor 解決
    （セッション → AdminUser）と各画面への適用は次増分**（現 `session.ts` は role:'admin'
    のみで RoleAssignment 未連携）。
- **テナント横断時の対象テナント明示**: `AdminShell` のヘッダに `tenantLabel` を常時表示
  （platform は「全テナント横断」、admin は将来 TenantSwitcher の選択値）。
- **危険操作の隔離**: 破壊的導線は `danger` フラグで明示し、本実装では DangerZone +
  理由入力 + 確認（#90）に隔離する。
- **機密値の非表示**: シークレットはフロントに返さない。登録状態・最終更新日時・接続確認
  状態のみ表示（#90 の SecretStatusField で実装）。

## 4. 既存ページへの影響（非破壊である根拠）

- **ルート不変**: 既存 `/admin/*` ページのパスは一切変更していない。`page.tsx` 群・
  `components/admin/*Manager` 群のロジックは無改変。
- **layout の差し替えのみ**: `src/app/admin/layout.tsx` を共通 `AdminShell` 利用に
  置き換え。表示するナビ項目・遷移先は従来と同一（IA グループ見出しと現在地表示を追加した
  だけ）。暫定ロール `tenant_admin` で全項目を表示し、従来の「全項目表示」を IA 上で再現。
- **API 不変**: `src/app/api/**` は変更なし。
- **#97 領域不可侵**: `src/domain/reservation/**`・`src/lib/reservation/**` は触れていない。

## 5. SPA ライク方針（#94）との関係

App Router のレイアウトネスト（`/admin` `/platform` の layout）でシェルを永続化し、
本文のみ差し替わる。共通シェル/ナビ/ガードを `components/admin/*` に集約したことで、
#94 でクライアント遷移（prefetch / 部分更新）へ寄せる際も IA とガードを再利用できる。

## 6. increment 計画

- **increment 1（本 PR）**: IA 確定（`navigation.ts`）+ 共通シェル/ナビ（`AdminShell` /
  `AdminNav`、責務グループ・現在地・ロール出し分け）+ `/platform` スケルトン（layout +
  dashboard プレースホルダ）+ route guard 雛形（`route-guard.ts`、適用例 1 箇所）+
  テーブルテスト。既存ページ非破壊。
- **increment 2 以降**: 実 actor 解決（セッション → AdminUser/RoleAssignment）と各画面への
  guard 厳密適用、TenantSwitcher、共通 UI（DataTable/MetricCard/StatusBadge/ConfirmDialog/
  DangerZone/SecretStatusField/Empty/Error/Loading）整備、既存ルートの正式名への段階 rename。
- **#90**: platform 各画面の本実装。**#82**: admin 各画面の運用機能。**#94**: SPA 化。
