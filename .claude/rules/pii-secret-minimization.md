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

## テナント別プロバイダ secret（CCaaS） (#405)

- secret の**値**を API 応答・画面・bundle・アプリログ・監査ログ・エラー/バリデーションメッセージに
  一切出さない（**write-only**・echo なし）。応答は presence（`set`|`missing`）のみ。
- **設定ストアに secret を保存しない**。`TenantProviderConfig`（`src/domain/provider-config/`）は
  非秘密設定のみを持ち、secret は `TenantSecretStore`（`src/domain/provider-config/secret.ts`）へ分離。
  設定 API は secret 風キー（`secret`/`privateKey`/`token`/`apiKey`/`password` 等）を検証段で拒否する。
- secret 値は `SecretValue` でラップして扱う（`toString`/`toJSON`/`util.inspect` が `[redacted]`）。
  `secret.ts` と `src/lib/platform/tenant-secret-store.ts` は **server-only**（`'use client'` から
  import 不可。`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
- 対象 `tenantId` は**サーバ側の認可済みコンテキスト**（選択中テナント Cookie の実在解決）から導出し、
  リクエスト body/query の `tenantId` を使わない（越境参照名を組ませない）。参照名は
  `tenants/<tenantId>/<provider>`。認可は `authorizePlatform`（developer 限定）＋
  `canManageTenantProviderConfig` に集約する。
- 監査に残すのは「誰が・どのテナントの・どの provider 設定を・set/clear したか」のみ（値なし）。
  既存 `AuditAction` の `integration.updated`/`secret.updated`/`secret.cleared` を使う。
- テストに実 secret 風文字列を置かず、明確な擬似値（`TEST-...`）を使う（gitleaks 誤検知・実鍵混入防止）。
