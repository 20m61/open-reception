# セキュリティレビュー チェックリスト (issue #6)

OWASP ASVS を参照軸に、open-reception の変更をレビューする際の確認項目。
GitHub Actions は使用しないため、SAST・依存監査・secret scan は **ローカル/任意 CI** で実行する。

## 実行コマンド（ローカル / 任意 CI）

```bash
npm run audit:deps     # 依存関係の脆弱性監査（本番依存）
npm run sast           # Semgrep SAST（semgrep CLI が必要）
npm run secrets:scan   # gitleaks による secret scan（gitleaks が必要）
npm run verify         # typecheck / lint / unit / build
npm run test:e2e       # 認可境界を含む e2e
```

## 認証・セッション（ASVS V2, V3）

- [ ] 管理画面/管理 API は管理セッション必須（`/admin/*`・`/api/admin/*`、middleware #24）
- [ ] kiosk セッションで管理 API を操作できない（role 分離、e2e で検証済み）
- [ ] セッション cookie は HttpOnly、本番は Secure、署名（HMAC）付き
- [ ] PIN/パスワードは server 側で検証し、値を GET API で返さない

## アクセス制御（ASVS V4）

- [ ] kiosk と admin の認可が混在しない
- [ ] 受付端末の PIN/IP 許可・端末失効・緊急停止が機能する（#23 #18 #29）
- [ ] 失効/緊急停止時に受付を停止し、個人情報を破棄する（#30）

## 入力検証（ASVS V5）

- [ ] API は型・必須・列挙・サイズを検証し、不正入力を 400 で拒否する
- [ ] 受付状態の不正遷移を拒否する（状態遷移モデル）
- [ ] アセットの形式/サイズを検証する（#27）

## ログ・プライバシー（ASVS V7, V8）

- [ ] 受付履歴/監査ログに来訪者の PII を保存しない
- [ ] ログに secret・トークンを出力しない
- [ ] 受付完了/キャンセル後に画面から個人情報を消す

## 秘匿情報（ASVS V6）

- [ ] secret は server-only 環境変数で扱い、`NEXT_PUBLIC_` を付けない
- [x] Vonage secret/private key をクライアント bundle に含めない: `'use client'` からの server-only secret 参照を禁止する静的ガードテスト（`src/lib/security/client-secret-guard.test.ts`、`npm test` に含む）
- [ ] `.env` を誤コミットしない（`npm run secrets:scan`）

## 通信・ヘッダ（ASVS V14）

- [ ] CSP / X-Frame-Options(DENY) / X-Content-Type-Options(nosniff) / Referrer-Policy / Permissions-Policy を付与（`next.config.ts`）
- [ ] CORS は既定（same-origin）。クロスオリジンを開放しない
- [ ] CSRF: 認証は SameSite=Lax cookie。状態変更 API は same-origin 前提

## 依存関係（ASVS V14.2）

- [ ] `npm run audit:deps` の高/重大を解消または明示的に許容
- [ ] 既知 CVE のあるバージョンを避ける（例: Next.js は CVE 修正版を使用）
