<!--
PR タイトルは squash 後の main コミットになります。Conventional Commits（日本語可）で。
  例: feat(reservation): 来訪予約ドメインと QR トークン発行 (#97)
-->

## 概要

<!-- 何を・なぜ。1〜3 行。 -->

Closes #<ISSUE>

## 変更点

-
-

## 受け入れ条件（Issue から転記）

- [ ]
- [ ]

## 品質ゲート（GitHub Actions 不使用 / ローカル実行）

- [ ] `./scripts/quality-gate.sh --pr` が green（typecheck / lint / unit / build）
- [ ] 影響範囲に応じて追加ゲートを実行（該当のみチェック）
  - [ ] `--secrets`（秘密情報・gitleaks）
  - [ ] `--sast` / `--audit`（依存・SAST）
  - [ ] `--e2e` / `--lighthouse`（UI / a11y / パフォーマンス）
- [ ] セルフレビュー実施（必要に応じて code-reviewer / silent-failure-hunter）

## セキュリティ / プライバシー / ライセンス

- [ ] フロント bundle に secret / private key を含めていない
- [ ] 個人情報は必要最小限・保存期間明示・監査ログ最小化
- [ ] 外部依存を追加した場合、#105 のライセンス/プライバシーチェックを通した
      （SPDX / LICENSE / 商用利用可否）

## 補足 / スクショ / 残課題

<!-- 外部リソース待ちで未検証の点があれば #65 へのスタックを明記 -->
