# 利用量・予想コスト・監査ログの可視化設計 (issue #89)

テナント管理者が「今月どれくらい使われているか」「月末の概算コストはいくらか」「誰がいつ
何をしたか」を把握できる管理 UI を段階的に提供する。本書は #89 の設計と、increment 1 の
スコープ・実装根拠・次増分への引き継ぎをまとめる。

関連: #82（管理者運用コンソール IA）, #86（ダッシュボード）, #80（マルチテナント認可基盤）,
#33 / `docs/cost-management-tags.md`（コストタグ方針）。

## 1. 全体方針

- **業務単位で見せる**: AWS / Vonage の技術単位だけでなく、受付件数・通話分数など運用者が
  理解できる単位で表示する。
- **「概算」「予想」を明記**: コストは確定値ではない。出力（API レスポンス）に `isEstimate`、
  用いた `assumptions`（単価仮定）を必ず同梱し、UI でも断り書きを必須表示する。
- **read 専用・PII なし**: 集計は読み取りのみ。来訪者の個人情報・機密値は集計にも表示にも
  出さない（元データの `ReceptionLog` / `AuditLog` が既に PII を持たない設計）。
- **テナント境界**: API 入口で `resolveAdminActor` → `canAccessTenant`（read）で参照可否を
  判定する。developer は横断閲覧可（対象テナントは UI で明示）。
- **純関数に集計を分離**: 集計・コスト概算は `src/domain/usage/**` の純関数に閉じ、境界値を
  ユニットテストで担保する。I/O・配線は `src/lib/usage/**` と API route が担う。

## 2. increment 1 のスコープ

### 含む

- `/admin/usage`: 当月の利用量（受付件数 / 呼び出し成功 / 未応答・失敗 / 通話分数 / 代替導線）
  を前月比較つきで表示。ログから確実に導ける指標のみ。
- `/admin/costs`: 当月の概算コスト・月末予想・サービス別内訳（Vonage / AWS）・前月比較・
  しきい値警告。すべて「概算」「予想」明記。
- read 専用集計 API: `GET /api/admin/usage?tenantId=`, `GET /api/admin/costs?tenantId=`。
- 純関数: `domain/usage/usage-summary.ts`（利用量集計）, `domain/usage/cost-estimate.ts`
  （コスト概算）。

### 含まない（次増分）

- 監査ログ可視化の新ビュー（既存 `/admin/audit` があるため非破壊。usage 配下の集計/フィルタ
  ビュー新設に留める方針だが本増分では未実装）。
- 実課金連携（AWS Cost Explorer / Vonage 明細）。
- 利用量推移グラフ（時系列チャート）、CSV エクスポート。
- 音声合成回数・API リクエスト数・管理ログイン数・外部連携失敗数（記録ソース未接続。UI では
  「準備中」と明示し、虚の数値を出さない）。

## 3. 利用量の集計根拠（`usage-summary.ts`）

| 指標 | 集計元 | 根拠・近似 |
| --- | --- | --- |
| 受付件数 | `ReceptionLog`（期間内 `startedAt`） | そのまま件数。 |
| 呼び出し成功 / 未応答 / 失敗 | `ReceptionLog.outcome` | `connected` / `timeout` / `failed`。 |
| 通話分数 | `ReceptionLog.durationMs`（connected の総和） | 分に切り上げ。**実 Vonage 課金分数の近似**であり実測突合は次増分。 |
| 代替導線 | `ReceptionLog.fallbackUsed` | true の件数。 |
| 管理ログイン数 / 外部連携失敗数 | `AuditLog` | 現状、判定できる監査アクションが無いため 0。フィールドは返し UI は「準備中」。 |

期間境界は **UTC 月初固定**（`[当月初, 翌月初)` の半開区間）。表示上のローカル日付ズレは許容し、
集計の再現性・テナント横断比較・テスト容易性を優先する。TZ 厳密化（テナントごとのタイムゾーン）
は次増分。

## 4. コスト概算の根拠（`cost-estimate.ts`）

概算コスト = 利用量 × 単価仮定。月末予想 = 経過日数あたりの概算を 1 日に均し、その月の総日数を
掛けた**線形外挿**（月初・経過 0 日は外挿せず `estimatedSoFar` を返す）。

### 単価仮定（すべて未確定の概算値）

| 区分 | 単価仮定 | 算定軸 |
| --- | --- | --- |
| Vonage（通話） | 15 円/分 | 接続済み通話の合計分数 |
| AWS（受付処理） | 2 円/件 | 受付件数（Lambda / API GW / DynamoDB をならした 1 件あたり） |
| 警告しきい値 | 50,000 円（月末予想） | これを超えたら UI で警告 |

> これらは実課金単価ではない。`docs/cost-management-tags.md` の `Component`（reception-api /
> notification など）に概念的に対応づくが、実値は実課金連携時に確定する。確定したら本表と
> `DEFAULT_COST_ASSUMPTIONS` を同時更新する。通貨は JPY 固定（多通貨は次増分）。

出力には `isEstimate: true`・`currency`・`assumptions` を必ず含め、UI が断定的な金額に
見せないようにする。

## 5. テナント境界とセキュリティ

- API は `resolveUsageScope`（`src/lib/usage/request.ts`）で
  `resolveAdminActor` → `tenantId` 必須 → `canAccessTenant(actor, tenantId, 'read')` を一括判定。
  未認証 401 / tenantId 欠落 400 / 他テナント参照 403。他テナントの利用量・コストが返らないことを
  ユニットテストで担保する。
- **ログストアのテナント分割は未完**（#80 のデータ層分割は別トラック）。現状の mock ログストアは
  単一ストアのため、本増分は「API 入口で参照可否を判定し、集計対象はストア全体」とする。
  ストアがテナント分割されたら `loadUsage` で `tenantId` フィルタを追加する（要 follow-up）。
- viewer は read のみ（`canRoleWrite` 対象外）。本機能は read 専用のため viewer も閲覧可能。

## 6. 次増分

1. 監査ログ可視化ビュー（usage 配下に検索・フィルタ。`/admin/audit` は非破壊）。
2. 実課金連携（AWS Cost Explorer / Vonage 明細）と単価仮定の実値化。
3. 利用量推移グラフ（時系列）、サービス別内訳の時系列。
4. 記録ソース追加（音声合成回数・API リクエスト数・管理ログイン・連携失敗）。
5. ログストアのテナント分割後の `tenantId` フィルタ適用、TZ 厳密化。
6. CSV エクスポート（権限を厳格化）。

## 7. intended nav 配線（オーケストレータが後で実施）

`src/components/admin/navigation.ts` の `ADMIN_NAV` に「状態確認」グループを新設するか、既存
`governance`（ガバナンス）グループへ以下を追加する想定（本トラックでは触らない）:

- `{ href: '/admin/usage', label: '利用量' }`（ロール: TENANT_VIEWERS）
- `{ href: '/admin/costs', label: '予想コスト' }`（ロール: TENANT_VIEWERS）
