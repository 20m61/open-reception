# 受付履歴・監査ログ方針 (issue #19)

## 目的

- 誰を呼んだか、応答/未応答/失敗/キャンセルだったか、所要時間、代替導線の利用を後から確認できるようにする。
- 同時に、来訪者の個人情報（PII）は最小限にし、保存内容とログ出力を制御する。

## 記録する情報

### ReceptionLog（受付履歴）

| 項目 | 内容 |
| --- | --- |
| receptionId | 受付セッション ID |
| kioskId | 受付端末 ID |
| purpose | 受付目的 |
| targetType / targetId / targetLabel | 呼び出し先（担当者/部署） |
| outcome | connected / timeout / failed / cancelled |
| failureReason | 失敗・未応答の理由 |
| fallbackUsed | 代替導線の利用有無 |
| startedAt / endedAt / durationMs | 受付開始・終了・所要時間 |

### AuditLog（監査ログ）

受付ライフサイクル（connected/timeout/failed/cancelled/completed/fallback_used）と、
将来の管理操作（セキュリティ設定変更 #29 など）の監査証跡を残す。

## PII 最小化方針

- **ReceptionLog / AuditLog に来訪者の氏名・会社名・要件メモを保存しない。**
  - 呼び出し先名（担当者・部署名）は運用上必要なため targetLabel として保持する。
- 受付端末画面は完了/キャンセル後に自動リセットし、入力した個人情報を画面に残さない。
- ログ出力に secret・トークン・過剰な個人情報を含めない。

## 保存期間・削除方針 (issue #313 で実効化)

保持期間は **requirements 4.6/5.2**（個人情報は最小限にし保存期間を設定できること）を満たすため、
新規に書き込む受付履歴・監査ログへ実際に TTL を適用する。

### 既定保持日数

| 対象 | 既定値 | 定数 | 下限 |
| --- | --- | --- | --- |
| 受付履歴（ReceptionLog） | 180 日 | `DEFAULT_RECEPTION_LOG_RETENTION_DAYS`（`src/domain/tenant/limits.ts`） | なし |
| 監査ログ（AuditLog） | 365 日 | `DEFAULT_AUDIT_LOG_RETENTION_DAYS`（同上） | `MIN_AUDIT_LOG_RETENTION_DAYS`（既定 90 日。運用者は env `OPEN_RECEPTION_AUDIT_LOG_MIN_RETENTION_DAYS` で引き上げ可能） |

監査ログは受付履歴より長め（コンプライアンス上の追跡証跡）にし、かつ **下限より短く設定できない**
（テナント設定がどんな値でも、実効値は下限へ切り上げられる。`resolveAuditLogRetentionDays`）。

### テナント別設定（TenantLimits）

- `TenantLimits`（`src/domain/tenant/limits.ts`）は 1 テナント 1 レコード（id = tenantId）で、
  `receptionLogRetentionDays` / `auditLogRetentionDays` を上書きできる。永続化は
  `src/lib/tenant/limits-store.ts`（`TenantLimitsRepository`）。未設定フィールドは既定値を使う。
- レコードを変更すると、**以後の新規書き込み**へ即座に反映される（次回 put() 時に都度解決するため
  キャッシュ経由の遅延はない）。
- 現状 `ReceptionLog` / `AuditLog`（`src/domain/reception/log.ts`）自体はテナント境界
  （tenantId）を持たない共有ログである（kiosk→tenant の実写像は #284 の残課題）。そのため本増分では
  「既定テナント」（`resolveDefaultScope` / `OPEN_RECEPTION_DEFAULT_TENANT_ID`、単一テナント運用の
  実体）の `TenantLimits` を全書き込みへ適用する。真の per-tenant 分離（ログへの tenantId 付与と
  テナントごとの異なる TTL 適用）は、kiosk→tenant 写像が入った後続増分で行う。
  テナント別の admin/platform API・UI（`TenantLimits` の編集画面）も未実装で、次の増分候補。

### 実装機構

- バックエンドは `DATA_BACKEND` で切替（`memory` / `dynamodb`、docs/persistence-design.md）。
  - **dynamodb**（本番）: 書き込み時に `src/lib/data-stores/log-retention.ts` が保持日数から
    `ttl`（epoch 秒、受付セッションと同じ既存の TTL 属性）を計算し、各 ReceptionLog/AuditLog の
    item に載せて書き込む。`DynamoLogStore.put()` は item をそのまま record へ展開するため、
    `LogOpts`/DynamoDB 側の変更は不要（既存の TTL 属性の仕組みをそのまま流用）。DynamoDB の
    TTL は失効後 48 時間以内に非同期で物理削除される（AWS の一般的な TTL 動作）。
  - **memory**（dev/test）: 実削除はせず、`MemoryLogStore`（`src/lib/data/memory.ts`）が
    `list`/`listSince`/`findBy` の**読み取り時**に `ttl` と現在時刻を比較して除外する
    （`src/lib/platform/repository.ts` の `expiresAt` 方式に倣う）。返却前に `ttl` フィールドは
    取り除く（dynamo 側の内部属性 strip と挙動を揃える）。
- `ttl` の起点はログの発生時刻（`ReceptionLog.createdAt` / `AuditLog.at`）。書き込み時刻ではないため、
  fallbackUsed 更新などで同一ログを再 put しても失効時刻はずれない。

### 既存レコードへの遡及適用（backfill）について

- **本増分では既存レコードへの遡及付与（backfill）は行わない。新規に書き込むレコードにのみ
  `ttl` を適用する。** 導入前に書かれた既存の受付履歴・監査ログは `ttl` を持たないため、
  DynamoDB TTL・memory の読み取り時判定のいずれでも対象外（無期限のまま）で、明示的な削除処理を
  実行するまで保持され続ける。
- 理由: (1) 既存データへの一括更新はコスト・リスクが大きく、対象範囲の間違いが不可逆な喪失に
  つながり得る。(2) 保持期間の既定値・下限は運用ポリシーの選択であり、遡及適用の要否・除外条件は
  テナントごとの合意が必要になり得る。
- 既存レコードにも保持期間を適用したい場合は、別増分で「対象レコードへ `ttl` を付与する一括更新
  バッチ」を設計・実行すること（本ドキュメントの更新と合わせてレビューを通す）。
- CloudWatch Logs を併用する場合は保持期間を明示設定し保存コストを抑える（SPEC #32 と整合）。

## 実装

- 型: `src/domain/reception/log.ts`
- 保持期間ドメイン: `src/domain/tenant/limits.ts`（`TenantLimits`・既定値・下限・TTL 変換の純関数）
- テナント別保持期間の永続化: `src/lib/tenant/limits-store.ts`（`TenantLimitsRepository`）
- TTL 解決: `src/lib/data-stores/log-retention.ts`（`resolveReceptionLogTtl` / `resolveAuditLogTtl`）
- ストア: `src/lib/data-stores/reception-log-store.ts` / `src/lib/data-stores/reception-log-repository.ts`
  （put() で ttl を付与）
- 受付フロー連携: `src/lib/data-stores/reception-store.ts`（終端遷移で記録）
- 管理閲覧: `/admin/receptions`、API `GET /api/admin/receptions`・`GET /api/admin/audit`
