# 管理画面 デザイン方針・コンポーネントカタログ (issue #92)

open-reception 管理画面（`/admin` テナント側 / `/platform` 運用側）の **デザイン方針** と、
共有 UI プリミティブ `src/components/admin/ui/**` の用途・Props・既存重複からの移行対応表を
定義する。IA・ルートは `docs/admin-frontend-design.md`（#85）を、危険操作の挙動は #91 を、
シークレット表示の挙動は #93 を正とする。本書はそれらと整合する **見た目の基準**。

## 0. increment と非破壊方針

- **increment 1（本 PR）= 新設のみ**: `src/components/admin/ui/**` に正準プリミティブを新設し、
  方針と移行対応表を文書化する。**既存コンポーネント/ページは一切改変しない**（並行安全）。
- **increment 2（次増分）= 移行**: 既存の重複コンポーネントを `ui/` へ寄せ、呼び出し側を
  差し替える。本書 §5 の対応表がその作業計画になる。

## 1. デザインキーワード（#92）

信頼できる / 静か / 視認性が高い / 余白を広めに取る / 状態が読みやすい /
非エンジニアでも迷わない / 危険操作は明確に分離する / テナント境界を強調する /
developer 画面は情報密度を高める。

## 2. 画面トーン差分（`/admin` と `/platform`）

| 観点         | `/admin`（テナント管理者・拠点担当者）       | `/platform`（総合開発者・運用者）              |
| ------------ | -------------------------------------------- | --------------------------------------------- |
| 言葉遣い     | やさしい業務語。技術名を前面に出さない        | 技術語可。対象・影響範囲を明示                  |
| 情報密度     | 余白広め・1 画面の指標は絞る                  | 高密度・横断一覧を許容                          |
| 目的         | 「いま受付が正常か」を最短把握 + 日常操作      | テナント横断の状態把握・危険操作の隔離実行       |
| 危険操作     | 原則出さない / 限定的                          | DangerZone に隔離し対象テナントを強調           |
| テナント表示 | 将来 TenantSwitcher の選択値をヘッダ固定       | 「全テナント横断」をヘッダ固定                  |

実装上はどちらも同じプリミティブを使い、**密度（余白・カード幅）と文言**で差を付ける。

## 3. デザイントークン（`ui/tokens.ts`）

CSS 変数（`src/app/globals.css` の `--color-*` / `--space-*`）を TypeScript から参照する
単一の入口。色はテーマ切替できるよう `var(--color-…)` 文字列で持つ。

- `color` … bg / surface / surface2 / text / muted / accent / success / danger / warning /
  border / borderStrong
- `space` … xs:6 / sm:12 / md:16 / lg:24 / xl:40（`--space-*` と整合）
- `radius` … sm:8 / md:12 / lg:16 / pill:999
- `font` … caption / small / body / label / metric
- 語彙（管理画面全体で統一）:
  - `StatusKind` = `ok | warning | critical | stopped | maintenance` → `STATUS_META`
  - `Tone` = `neutral | success | warning | danger | accent` → `TONE_COLOR` / `TONE_SOFT_BG`
  - `SecretPresence` = `configured | missing | needs_rotation` → `SECRET_META`

### 余白・色・状態の運用ルール（#92 表示ルール）

- **状態表現を統一**: 正常 / 注意 / 異常 / 停止 / メンテナンス中（`STATUS_META`）。
- **コストは必ず「概算」「予想」を明記**（MetricCard の `hint` に入れる）。
- **機密値は状態だけ表示**: 登録済み / 未設定 / 要更新（`SECRET_META`）。値は扱わない。
- **危険操作は通常フォームに紛れ込ませない**: `DangerZone` に隔離する。
- **テナント横断画面は対象テナントを画面上部に固定**（`AdminShell` ヘッダ）。

## 4. プリミティブ一覧（用途 / 主要 Props）

| プリミティブ        | ファイル                 | 用途                                   | 主要 Props |
| ------------------- | ------------------------ | -------------------------------------- | ---------- |
| デザイントークン    | `tokens.ts`              | 色/間隔/角丸/タイポ/状態語彙の単一入口  | （定数・型） |
| `Button`            | `Button.tsx`             | 管理画面標準ボタン                      | `variant: primary\|secondary\|ghost\|danger` ＋ 標準 button 属性 |
| `Card`              | `Card.tsx`               | 汎用の囲み                              | `children`, `style?`, `testId?` |
| `MetricCard`        | `Card.tsx`               | 1 指標を大きく表示                      | `label`, `value?`, `unit?`, `tone?`, `hint?`, `note?`, `placeholder?` |
| `CardGrid`          | `Card.tsx`               | カードのレスポンシブグリッド            | `children`, `minWidth?` |
| `Section`           | `Section.tsx`            | 見出し + 説明 + 右肩アクション + 本文    | `title`, `description?`, `actions?`, `children` |
| `StatusBadge`       | `StatusBadge.tsx`        | 5 状態の統一バッジ                      | `status: StatusKind`, `label?` |
| `DataTable`         | `DataTable.tsx`          | 列定義ベースの汎用テーブル（空時 Empty） | `columns`, `rows`, `rowKey`, `emptyMessage?`, `testId?` |
| `Field`             | `Field.tsx`              | ラベル + 入力 + 補足/エラー             | `label`, `htmlFor?`, `hint?`, `error?`, `required?`, `children` |
| `FormRow`           | `Field.tsx`              | Field の横並び行                        | `children` |
| `SecretStatusField` | `SecretStatusField.tsx`  | 機密の **状態のみ** 表示（視覚の器）     | `name`, `presence: SecretPresence`, `updatedLabel?`, `actions?` |
| `DangerZone`        | `DangerZone.tsx`         | 危険操作セクションの **視覚の器**         | `title?`, `description?`, `children` |
| `EmptyState`        | `EmptyState.tsx`         | 0 件時の自然な案内                       | `title?`, `message?`, `action?`, `testId?` |

> `SecretStatusField` は型に value を持たない（機密値を渡せない）。`DangerZone` は
> レイアウトのみで、確認導線・理由入力・監査連携は #91 `components/admin/danger/**` が担う。

## 5. 既存重複コンポーネント → `ui/` 移行対応表（increment 2 で実施）

increment 2（本増分）で dashboard / usage / costs / integrations の重複コンポーネントを
共有 `ui/` プリミティブ利用へ寄せた。移行元ファイルは **薄い委譲 / re-export シム** にして
import パスと `data-testid` を互換維持し、表示・テストの挙動は変えていない（リファクタ）。

| 既存（現状）                                                   | 寄せ先（`ui/`）          | 状態 / 移行メモ |
| -------------------------------------------------------------- | ------------------------ | -------------- |
| `admin/dashboard/MetricCard.tsx`                              | `ui/Card` の `MetricCard` | ✅ 完了。`ui/MetricCard` に `href`（Link 包み + 「詳細を見る →」）と `testId`/`noteTestId` を追加し委譲。`metric-card`/`metric-note`/`metric-card-link` testid 維持 |
| `admin/usage/UsageCard.tsx`（`UsageCard` / `CardGrid`）        | `ui/Card`（`MetricCard` / `CardGrid`） | ✅ 完了。`alwaysShowNote` で usage の note 常時表示を再現。`usage-card`/`usage-note` testid 維持。`CardGrid` は `ui/CardGrid` へ委譲 |
| `admin/dashboard/StatusBadge.tsx`                            | `ui/StatusBadge`          | ✅ 完了。`OverallStatus`（3 値）→ `StatusKind` マップ + 業務文言（ok=正常稼働中）付与の薄い委譲。`dashboard-status-badge` testid 維持 |
| `admin/dashboard/Section.tsx`（`Section` / `CardGrid`）        | `ui/Section` ＋ `ui/Card` の `CardGrid` | ✅ 完了。`ui` からの re-export シム化（CardGrid は Card 側へ集約済み） |
| `admin/dashboard/RecentCalls.tsx` の table 描画                | `ui/DataTable`            | ✅ 完了。列定義へ書き換え。空状態は `ui/DataTable`→`ui/EmptyState` に委譲（`recent-calls-table` testid 維持） |
| `admin/integrations/SecretStatusField.tsx`                   | `ui/SecretStatusField`    | ✅ 完了。視覚を `ui/` に寄せ、操作（onMarkUpdated/onClear）は `actions` に `ui/Button` で注入。presence+health→3 状態語彙にマップ。`secret-<key>` 系 testid 維持 |
| 各 `*Manager.tsx` のインライン ghost/danger/primary ボタン     | `ui/Button`               | ✅ 完了。接続テスト/確認/再読み込みボタンを `variant` へ集約。data-testid は呼び出し側で付与 |
| 各画面のインライン入力 + ラベル                                 | `ui/Field` / `ui/FormRow` | 対象外（本増分の dashboard/usage/costs/integrations にはフォーム入力なし。reservations 等は別増分） |
| 危険操作の素のセクション（将来 #91）                            | `ui/DangerZone`           | 対象外（#91 danger/ の責務。本増分の 4 画面に危険操作なし） |

## 6. アクセシビリティ 最低基準

- **コントラスト**: 色トークンはダーク地に対し十分な明度差を持つ前景色を使う。状態は色 **だけ**
  に依存せずラベル文言（`STATUS_META.label`）を併記する。
- **フォーカス可視**: ボタン/入力はブラウザ既定のフォーカスリングを潰さない。
- **ラベル結合**: フォームは `Field` の `htmlFor` と入力の `id` を必ず結ぶ。
- **装飾の非読み上げ**: バッジのドット等は `aria-hidden`。
- **タッチ/クリック領域**: 管理画面ボタンは最小高 34px（受付端末向け 64px とは別系統）。
- **空/危険の明示**: 空状態は文章で案内、危険操作は文言・配置・色で明確に分離する。

## 7. 新規画面チェックリスト

- [ ] トークン（`ui/tokens`）を使い、色・間隔・角丸をハードコードしていない
- [ ] 状態表示は `StatusBadge`（5 状態語彙）に揃えた
- [ ] コスト値に「概算 / 予想」を明記した
- [ ] 機密は `SecretStatusField`（状態のみ）で表示し、値を画面に出していない
- [ ] 危険操作は `DangerZone` に隔離し、通常フォームに混ぜていない
- [ ] テナント横断画面は対象テナントを上部に固定した
- [ ] 一覧の 0 件時に `EmptyState` で自然な案内を出した
- [ ] フォームはラベルと入力を `htmlFor`/`id` で結んだ
- [ ] 状態を色だけに頼らずラベルを併記した
