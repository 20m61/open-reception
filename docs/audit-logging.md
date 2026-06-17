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

## 保存期間・削除方針

- mock backend（現状）はプロセス内に保持し、上限件数（受付 1000 / 監査 5000）を超えると古いものから破棄する。
- 本番の永続化層へ移行する際は、以下を設定する。
  - 受付履歴: 保持期間（例: 180 日）を設け、期限超過分を定期削除する。
  - 監査ログ: コンプライアンス要件に応じた保持期間を設定する。
  - CloudWatch Logs 等を使う場合は保持期間を明示設定し、保存コストを抑える（SPEC #32 と整合）。

## 実装

- 型: `src/domain/reception/log.ts`
- ストア: `src/lib/mock-backend/reception-log-store.ts`
- 受付フロー連携: `src/lib/mock-backend/reception-store.ts`（終端遷移で記録）
- 管理閲覧: `/admin/receptions`、API `GET /api/admin/receptions`・`GET /api/admin/audit`
