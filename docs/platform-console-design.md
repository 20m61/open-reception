# プラットフォーム運用コンソール設計 (issue #90)

総合開発者・プラットフォーム運用者（`developer` ロール）向けの、テナント横断運用コンソール
（`/platform/*`）のフロント基盤と安全 UX を定義する。本書は #83（総合開発者ロール）の
セキュリティ原則を `/platform` の具体画面・API に落とし込む。IA / ルートは #85
（`src/components/admin/navigation.ts` の `PLATFORM_NAV`）で確定済みであり、本コンソールは
それを**参照のみ**で実装する。

## 位置づけ・前提

- エリアガード: `src/app/platform/layout.tsx`（#85/#117）が `resolveAdminActor()` +
  `canEnterArea(actor, 'platform')`（= developer のみ）で入口を守る。**layout は本 Issue で編集しない。**
- 認可の正は **API 側**: 表示制御（layout/nav）は UX に過ぎず、データ露出は各 platform API の
  `authorizePlatform()`（未認証 401 / 非 developer 403）が守る（`src/lib/platform/request.ts`）。
- `developer` は env の明示 allowlist（`OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS`）または
  `OPEN_RECEPTION_ADMIN_PASSWORD_ROLE=developer` でのみ付与（最小権限、`src/lib/auth/actor.ts`）。

## 安全 UX 方針（#83 準拠）

1. **通常時は読み取り中心**: 一覧・概況・状態確認のみを既定で提供する。
2. **対象テナントの常時明示**: 画面上部に対象（全テナント横断 / 選択テナント）を常に表示する
   （`AdminShell` の `tenantLabel`）。
3. **破壊的操作の隔離**: 有効/停止・機能制限変更・シークレット再登録・メンテナンス発動などは
   `DangerZone` に隔離し、**操作理由の入力・確認文言・影響範囲の表示・必要に応じた再認証/昇格・
   監査記録**を必須にする。本増分では `DangerActionPlaceholder` で「確認/昇格が必要」と明示し
   無効化する（実装は次増分）。
4. **機密値・PII の非露出**: API シークレット・秘密鍵などは表示せず、登録状態・最終更新日時・
   接続確認状態のみを見せる。来訪者/担当者の個人情報は表示しない。監査ログはマスク済み。
5. **すべての platform 操作を監査対象にする**: 破壊的操作の実装時に既存 `AuditAction` を参照して
   記録する（本増分は read 中心のため新規監査アクションは未追加。必要時は report に列挙）。

## 画面一覧（PLATFORM_NAV 準拠）

| ルート | 区分 | 本増分(inc1)の実装 |
| --- | --- | --- |
| `/platform` | 概況 | **実装**: テナント数/稼働/停止の概況。運用指標は「未接続」明示 |
| `/platform/tenants` | テナント運用 | **実装**: テナント一覧 read（メタ情報のみ）。操作は Danger プレースホルダ |
| `/platform/feature-flags` | テナント運用 | スケルトン（read 中心。変更は Danger プレースホルダ） |
| `/platform/integrations` | テナント運用 | スケルトン（登録状態のみ。機密値は非露出） |
| `/platform/observability` | 信頼性 | スケルトン（指標ソース接続は次増分） |
| `/platform/maintenance` | 信頼性 | スケルトン（発動は Danger プレースホルダ） |
| `/platform/audit-logs` | 信頼性 | スケルトン（マスク済み読み取り。配線は次増分） |

## API（developer 専用 read）

- `GET /api/platform/dashboard` — 全テナント稼働概況（`fleet`）+ 未接続運用指標（`metrics.*.status='pending'`）。
- `GET /api/platform/tenants` — 全テナント一覧（メタ情報のみ）+ 概況サマリ。

いずれも `authorizePlatform()` で developer 以外を 401/403 で弾く。集計は純関数
`src/domain/platform/console-summary.ts`（`summarizeTenantFleet` / `toTenantRows`）に委譲し
ユニットテストで網羅する。テナントデータは目的限定の read（メタ情報のみ）で、PII・機密値を
含めない。

## ディレクトリ

- ページ: `src/app/platform/**`
- API: `src/app/api/platform/**`（read のみ）
- 認可ヘルパ: `src/lib/platform/request.ts`
- 集計純関数: `src/domain/platform/console-summary.ts`
- platform 固有 UI: `src/components/admin/platform/**`（共有プリミティブ #92 が来たら寄せる）

## increment 計画

- **inc1（本増分）**: read 中心の画面基盤 + developer 専用 read API + 安全 UX の枠組み
  （Danger プレースホルダ・対象テナント明示・未接続指標の明示）。
- **inc2 以降**:
  - テナント詳細・対象テナント選択（選択中テナントの常時表示と read スコープの絞り込み）。
  - 機能フラグ / 利用制限のテナント単位 read（→ 変更は昇格 UX）。
  - 外部連携の登録状態・接続確認 read。
  - オブザーバビリティ指標ソース接続（エラー率/レイテンシ/利用量、マスク済み直近ログ）。
  - メンテナンス状態の read（→ 発動は影響範囲表示 + 昇格 + 監査）。
  - 監査ログのテナント横断マスク読み取り配線。
  - 破壊的操作の Just-in-Time 昇格・理由入力・確認・影響範囲表示・監査（既存 `AuditAction` 参照）。
