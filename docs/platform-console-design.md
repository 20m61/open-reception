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

| ルート | 区分 | 実装状況（inc1 → inc2） |
| --- | --- | --- |
| `/platform` | 概況 | inc1 **実装**: テナント数/稼働/停止の概況。運用指標は「未接続」明示 |
| `/platform/tenants` | テナント運用 | inc1 一覧 read → inc2 **詳細 read 導線**（行から詳細へ遷移） |
| `/platform/tenants/[tenantId]` | テナント運用 | inc2 **実装**: テナント詳細 read（サイト/端末の数・状態。PII/機密なし）。操作は Danger プレースホルダ |
| `/platform/feature-flags` | テナント運用 | inc1 スケルトン → inc2 **read 実接続**（Vonage/ログイン方式は実値、上限は「未接続」明示）。変更は Danger プレースホルダ |
| `/platform/integrations` | テナント運用 | inc1 スケルトン → inc3 **read 実接続**（外部連携＋管理ログイン方式の登録/有効/接続結果。機密値は非露出）。変更は Danger プレースホルダ |
| `/platform/observability` | 信頼性 | inc1 スケルトン → inc2 **read 実接続**（連携接続結果・マスク済み直近アクティビティ。指標は「未接続」明示） |
| `/platform/maintenance` | 信頼性 | inc1 スケルトン → inc2 端末横断集計 → inc3e **障害/インシデント read 追加**（進行中件数・重大度内訳・横断一覧）。発動/登録は Danger プレースホルダ |
| `/platform/audit-logs` | 信頼性 | inc1 スケルトン → inc2 **read 実接続**（テナント横断マスク済み監査ログ） |

## API（developer 専用 read）

inc1:

- `GET /api/platform/dashboard` — 全テナント稼働概況（`fleet`）+ 未接続運用指標（`metrics.*.status='pending'`）。
- `GET /api/platform/tenants` — 全テナント一覧（メタ情報のみ）+ 概況サマリ。

inc3（追加）:

- `GET /api/platform/integrations` — 外部連携（Vonage 等）＋管理ログイン方式（Entra/Cognito/共有
  パスワード）の登録状態・有効状態・接続結果・最終日時。**機密値は含めない**（射影 whitelist）。

inc2（追加）:

- `GET /api/platform/tenants/[tenantId]` — テナント詳細（メタ + サイト/端末の数・状態）。未存在は 404。
- `GET /api/platform/feature-flags` — 機能フラグ（Vonage `configured/enabled`・管理ログイン方式）。
  音声合成/VRM/各利用上限は `status:'pending'`。**機密値は含めない。**
- `GET /api/platform/observability` — 外部連携の接続結果 + マスク済み直近アクティビティ。
  エラー率/レイテンシ/利用量/アラートは `status:'pending'`。
- `GET /api/platform/maintenance` — メンテナンス表示中端末の横断集計。お知らせ/障害情報は `pending`。
- `GET /api/platform/audit-logs` — テナント横断のマスク済み監査ログ（新しい順・上限つき）。

いずれも `authorizePlatform()` で developer 以外を 401/403 で弾く。集計・射影は純関数
`src/domain/platform/console-summary.ts`（inc1: `summarizeTenantFleet` / `toTenantRows`、
inc2: `summarizeTenantDetail` / `summarizeMaintenance` / `maskAuditActor` / `toMaskedAuditRows`）
に委譲しユニットテストで網羅する。データは目的限定の read（メタ情報のみ）で、PII・機密値を
含めない。監査ログは actor の識別子部分をマスクし metadata を表示行に載せない。read 元は既存
ストア（`@/lib/tenant/store`・`@/lib/security/integration-status-store`・
`@/lib/mock-backend/reception-log-store`・`@/lib/call/vonage-config`）を**参照のみ**で利用する
（既存ファイルは編集しない）。

## ディレクトリ

- ページ: `src/app/platform/**`
- API: `src/app/api/platform/**`（read のみ）
- 認可ヘルパ: `src/lib/platform/request.ts`
- 集計純関数: `src/domain/platform/console-summary.ts`
- platform 固有 UI: `src/components/admin/platform/**`（共有プリミティブ #92 が来たら寄せる）

## increment 計画

- **inc1**: read 中心の画面基盤 + developer 専用 read API + 安全 UX の枠組み
  （Danger プレースホルダ・対象テナント明示・未接続指標の明示）。
- **inc2（本増分）**: 各 platform 画面の read 実接続。
  - テナント詳細 read（サイト/端末の数・状態。`/platform/tenants/[tenantId]`、一覧から導線）。
  - 機能フラグ read 実接続（Vonage・管理ログイン方式は実値。利用上限は「未接続」明示）。
  - オブザーバビリティ read 実接続（連携接続結果・マスク済み直近アクティビティ。指標は「未接続」）。
  - メンテナンス read 実接続（メンテナンス表示中端末の横断集計）。
  - 監査ログのテナント横断マスク読み取り配線（actor マスク・metadata 非表示）。
  - 破壊的操作は引き続き Danger プレースホルダ（昇格・確認・監査は未実装）。
- **inc3（#83 のスコープ分割）**: 残りの read 配線を小さく安全な増分へ分割し、書き込み（破壊的操作）
  の前提となる JIT 昇格基盤を後段に置く。各増分は純関数射影＋ユニットテスト＋ authorizePlatform()
  ガードを守り、機密値・PII を露出しない。
  - **inc3a（実装済 / 本増分）**: 外部連携の登録状態・接続確認 read（`/platform/integrations` 配線）。
    `GET /api/platform/integrations`＋射影 `toIntegrationStatusRows` / `toAuthMethodStatusRows`。
  - **inc3b**: 対象テナント選択 UX（選択中テナントの常時表示と read スコープの絞り込み）。
  - **inc3c**: 機能フラグ / 利用制限のテナント単位 read と利用量メータリング接続（#89）。
  - **inc3d**: オブザーバビリティ指標ソース接続（エラー率/レイテンシ/利用量/アラート履歴）。
  - **inc3e（一部実装済）**: 障害（Incident）の状態 read を `/platform/maintenance` へ追加
    （`summarizeIncidents`＋`incident-store`。seed は memory 専用＝本番 DynamoDB はダミーを出さない）。
    MaintenanceWindow（予定メンテナンス）read は未着手（→ 発動/登録は影響範囲表示 + 昇格 + 監査）。
- **inc4 以降（書き込み・安全装置）**:
  - 破壊的操作の Just-in-Time 昇格・理由入力・確認・影響範囲表示・MFA 再認証・期限付き昇格・
    break-glass 分離・高詳細監査（before/after・IP・UA、新規 `AuditAction`）。
  - 機能フラグ／利用制限の変更、メンテナンス発動、保守操作（usage 再集計・webhook 再送・端末 token 失効 等）。
