---
paths:
  - "src/**"
---

# 個人情報・機密の最小化（#105 / #19）

- フロントエンド bundle に secret / private key / clientSecret / webhook secret を含めない
  （`NEXT_PUBLIC_` を機密に付けない。サーバ専用 env で扱う）。
- 監査ログ（`AuditLog.metadata`）・API レスポンス・アプリログに、来訪者の氏名/会社名/メモ等の
  PII や token/secret の平文を残さない。記録は「誰を呼んだか・結果・所要時間・状態」など運用に
  必要な最小情報のみ。
- QR には個人情報を埋め込まず、推測困難な `reservationToken`（高エントロピー）のみを載せる。
- カメラ/音声の生データは端末内処理に留め、送信・保存しない（presence/QR デコード）。
- 顔認証・録画・録音・生体情報は初期スコープ外。
- 監査アクションを増やすときは `src/domain/reception/log.ts` の `AuditAction` に追加する。
  表示ラベル（`src/app/admin/audit/page.tsx`）は非網羅マップ + フォールバックなので必須ではない。
